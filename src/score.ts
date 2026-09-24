/**
 * Scoring. Every check for a prompt rides in one request, and as many prompts
 * as the context budget allows ride in that same request.
 *
 * Jev ingests the state once and evaluates all questions against it in
 * parallel, so the seven checks plus the two applicability gates cost about
 * what one question would. Batching on top of that is what makes a backfill
 * over thousands of prompts affordable.
 */
import { CHECKS, type CheckDef, type CheckId, GATES, type GateId } from './checks.js';
import { ask, estimateTokens, MODEL, type NoulQuestion, tryAsk, type Usage } from './jev.js';
import type { ScoreRecord } from './log.js';
import { runPool } from './pool.js';

/** Total context is 64k for state plus every question; stay well inside it. */
const REQUEST_TOKEN_BUDGET = 48_000;
/** State alone shares a 32k budget with the longest single question. */
const STATE_TOKEN_BUDGET = 24_000;
const MAX_PROMPTS_PER_REQUEST = 60;
const MAX_PROMPT_CHARS = 4_000;

export type Verdict = 'pass' | 'fail' | 'undecided' | 'n/a';

export interface CheckResult {
  id: CheckId;
  label: string;
  verdict: Verdict;
  probability: number | null;
  def: CheckDef;
}

export interface PromptScore {
  hash: string;
  /** Passing checks over applicable checks, 0-100. Null when nothing applied. */
  score: number | null;
  checks: CheckResult[];
  gates: Partial<Record<GateId, number>>;
}

/** Keep the head and tail: a verification command is often the last line. */
export function clampPrompt(text: string): string {
  if (text.length <= MAX_PROMPT_CHARS) return text;
  return `${text.slice(0, MAX_PROMPT_CHARS - 1000)}\n…\n${text.slice(-1000)}`;
}

/**
 * @param contextIds Earlier messages from the same session that are in the
 *   state as background. Only `id` is judged; what the context already told
 *   the agent counts as known.
 */
function questionsFor(id: string, contextIds: string[] = []): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = {};
  const scope = contextIds.length
    ? `Judge only the message with id "${id}" in the state. The messages ${contextIds
        .map((c) => `"${c}"`)
        .join(
          ' and ',
        )} are earlier prompts from the same conversation, given as context: anything they already state counts as known to the reader of "${id}", but they are not themselves being judged.`
    : `Consider only the message with id "${id}" in the state.`;
  for (const gate of GATES) {
    questions[`${id}__${gate.id}`] = {
      type: 'noul',
      instructions: `${scope} ${gate.instructions}`,
      criteria: gate.criteria,
    };
  }
  for (const check of CHECKS) {
    questions[`${id}__${check.id}`] = {
      type: 'noul',
      instructions: `${scope} ${check.instructions}`,
      criteria: check.criteria,
    };
  }
  return questions;
}

function questionTokens(questions: Record<string, NoulQuestion>): number {
  return Object.values(questions).reduce(
    (sum, q) => sum + estimateTokens(q.instructions + q.criteria.true + q.criteria.false),
    0,
  );
}

export interface ScoreInput {
  hash: string;
  text: string;
}

interface Batch {
  items: { key: string; input: ScoreInput }[];
  /** Estimated input tokens for the request: state plus every question. */
  tokens: number;
}

/** Pack prompts into requests that fit both the total and the state-only budget. */
export function planBatches(inputs: ScoreInput[]): Batch[] {
  const batches: Batch[] = [];
  let current: Batch = { items: [], tokens: 0 };
  let stateTokens = 0;

  inputs.forEach((input, index) => {
    const key = `m${index}`;
    const text = clampPrompt(input.text);
    const itemStateTokens = estimateTokens(text) + 12;
    const itemTokens = itemStateTokens + questionTokens(questionsFor(key));

    const wouldOverflow =
      current.items.length > 0 &&
      (current.items.length >= MAX_PROMPTS_PER_REQUEST ||
        stateTokens + itemStateTokens > STATE_TOKEN_BUDGET ||
        current.tokens + itemTokens > REQUEST_TOKEN_BUDGET);

    if (wouldOverflow) {
      batches.push(current);
      current = { items: [], tokens: 0 };
      stateTokens = 0;
    }

    current.items.push({ key, input: { hash: input.hash, text } });
    stateTokens += itemStateTokens;
    current.tokens += itemTokens;
  });

  if (current.items.length > 0) batches.push(current);
  return batches;
}

/**
 * Input tokens a scoring pass over these prompts would bill, taken from the
 * batches it would actually send so a pre-flight quote cannot drift from the
 * request behind it.
 */
export function estimateScoringTokens(texts: string[]): number {
  const inputs = texts.map((text, index) => ({ hash: String(index), text }));
  return planBatches(inputs).reduce((sum, batch) => sum + batch.tokens, 0);
}

/** Turn raw probabilities into verdicts, honouring the applicability gates. */
export function interpret(
  hash: string,
  probabilities: Partial<Record<CheckId, number>>,
  gates: Partial<Record<GateId, number>>,
  opts: { inlineSafe?: boolean } = {},
): PromptScore {
  const checks = CHECKS.map((def): CheckResult => {
    const gate = def.appliesWhen;
    if (gate) {
      const gateValue = gates[gate.gate];
      if (gateValue === undefined || gateValue < gate.minProbability) {
        return { id: def.id, label: def.label, verdict: 'n/a', probability: null, def };
      }
    }
    const p = probabilities[def.id];
    if (p === undefined) {
      return { id: def.id, label: def.label, verdict: 'undecided', probability: null, def };
    }
    // In the inline path a check we cannot stand behind, or a finding sitting
    // near the threshold, is dropped rather than shown: a false positive there
    // interrupts every message.
    if (opts.inlineSafe && (!def.inlineEligible || Math.abs(p - def.threshold) < def.inlineMargin)) {
      return { id: def.id, label: def.label, verdict: 'undecided', probability: p, def };
    }
    return { id: def.id, label: def.label, verdict: p >= def.threshold ? 'pass' : 'fail', probability: p, def };
  });

  const decided = checks.filter((c) => c.verdict === 'pass' || c.verdict === 'fail');
  const score = decided.length
    ? Math.round((decided.filter((c) => c.verdict === 'pass').length / decided.length) * 100)
    : null;

  return { hash, score, checks, gates };
}

export interface ScoreRunOptions {
  timeoutMs?: number;
  concurrency?: number;
  onUsage?: (usage: Usage) => void;
  onProgress?: (done: number, total: number) => void;
}

/** Pull one prompt's probabilities and gate values out of a batched answer set. */
function unpack(answers: Record<string, number>, key: string, hash: string, ts: string): ScoreRecord {
  const probabilities: Partial<Record<CheckId, number>> = {};
  const gates: Partial<Record<GateId, number>> = {};
  for (const check of CHECKS) {
    const value = answers[`${key}__${check.id}`];
    if (value !== undefined) probabilities[check.id] = value;
  }
  for (const gate of GATES) {
    const value = answers[`${key}__${gate.id}`];
    if (value !== undefined) gates[gate.id] = value;
  }
  return { hash, ts, probabilities, gates, model: MODEL };
}

async function runBatch(batch: Batch, options: ScoreRunOptions): Promise<ScoreRecord[]> {
  const state = {
    messages: batch.items.map((item) => ({ id: item.key, text: item.input.text })),
  };
  const questions: Record<string, NoulQuestion> = {};
  for (const item of batch.items) Object.assign(questions, questionsFor(item.key));

  const answers = await ask(state, questions, {
    timeoutMs: options.timeoutMs ?? 60_000,
    onUsage: options.onUsage,
  });

  const now = new Date().toISOString();
  return batch.items.map((item) => unpack(answers, item.key, item.input.hash, now));
}

/** Score many prompts. Batches that fail are dropped, not retried forever. */
export async function scoreMany(inputs: ScoreInput[], options: ScoreRunOptions = {}): Promise<ScoreRecord[]> {
  return runPool(
    planBatches(inputs),
    options.concurrency ?? 6,
    (batch) => runBatch(batch, options),
    options.onProgress,
  );
}

/**
 * Score a single prompt. Used by /jevpromptcoach:score and by `always` mode.
 *
 * `context` is earlier prompts from the same session, oldest first, already
 * through the configured privacy level. They are sent but not scored.
 */
export async function scoreOne(
  text: string,
  hash: string,
  options: { timeoutMs?: number; inlineSafe?: boolean; context?: string[] } = {},
): Promise<{ record: ScoreRecord; result: PromptScore } | null> {
  const context = (options.context ?? []).map((t, i) => ({ id: `c${i + 1}`, text: clampPrompt(t) }));
  const state = { messages: [...context, { id: 'm0', text: clampPrompt(text) }] };
  const answers = await tryAsk(
    state,
    questionsFor(
      'm0',
      context.map((c) => c.id),
    ),
    { timeoutMs: options.timeoutMs ?? 20_000 },
  );
  if (!answers) return null;

  const record = unpack(answers, 'm0', hash, new Date().toISOString());
  if (context.length) record.context = context.length;
  return { record, result: interpret(hash, record.probabilities, record.gates, options) };
}
