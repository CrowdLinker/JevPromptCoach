/**
 * Scoring. Every check for a prompt rides in one request, and as many prompts
 * as the context budget allows ride in that same request.
 *
 * Jev ingests the state once and evaluates all questions against it in
 * parallel, so the seven checks plus the two applicability gates cost about
 * what one question would. Batching on top of that is what makes a backfill
 * over thousands of prompts affordable.
 */
import { CHECKS, GATES, CHECK_BY_ID, type CheckId, type CheckDef } from './checks.js';
import { ask, tryAsk, estimateTokens, type NoulQuestion, type Usage, MODEL } from './jev.js';
import type { ScoreRecord } from './log.js';

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
  gates: Record<string, number>;
}

/** Keep the head and tail: a verification command is often the last line. */
export function clampPrompt(text: string): string {
  if (text.length <= MAX_PROMPT_CHARS) return text;
  return `${text.slice(0, MAX_PROMPT_CHARS - 1000)}\n…\n${text.slice(-1000)}`;
}

function questionsFor(id: string): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = {};
  const scope = `Consider only the message with id "${id}" in the state.`;
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
    (sum, q) => sum + estimateTokens(q.instructions + (q.criteria ? q.criteria.true + q.criteria.false : '')),
    0,
  );
}

export interface ScoreInput { hash: string; text: string }

interface Batch { items: { key: string; input: ScoreInput }[] }

/** Pack prompts into requests that fit both the total and the state-only budget. */
export function planBatches(inputs: ScoreInput[]): Batch[] {
  const batches: Batch[] = [];
  let current: Batch = { items: [] };
  let stateTokens = 0;
  let totalTokens = 0;

  inputs.forEach((input, index) => {
    const key = `m${index}`;
    const text = clampPrompt(input.text);
    const itemStateTokens = estimateTokens(text) + 12;
    const itemQuestionTokens = questionTokens(questionsFor(key));

    const wouldOverflow =
      current.items.length > 0 &&
      (current.items.length >= MAX_PROMPTS_PER_REQUEST ||
        stateTokens + itemStateTokens > STATE_TOKEN_BUDGET ||
        totalTokens + itemStateTokens + itemQuestionTokens > REQUEST_TOKEN_BUDGET);

    if (wouldOverflow) {
      batches.push(current);
      current = { items: [] };
      stateTokens = 0;
      totalTokens = 0;
    }

    current.items.push({ key, input: { hash: input.hash, text } });
    stateTokens += itemStateTokens;
    totalTokens += itemStateTokens + itemQuestionTokens;
  });

  if (current.items.length > 0) batches.push(current);
  return batches;
}

/** Turn raw probabilities into verdicts, honouring the applicability gates. */
export function interpret(
  hash: string,
  probabilities: Partial<Record<CheckId, number>>,
  gates: Record<string, number>,
  opts: { inlineSafe?: boolean } = {},
): PromptScore {
  const checks: CheckResult[] = CHECKS.map((def) => {
    const gate = def.appliesWhen;
    if (gate) {
      const gateValue = gates[gate.gate];
      if (gateValue === undefined || gateValue < gate.minProbability) {
        return { id: def.id, label: def.label, verdict: 'n/a' as Verdict, probability: null, def };
      }
    }
    const p = probabilities[def.id];
    if (p === undefined) {
      return { id: def.id, label: def.label, verdict: 'undecided' as Verdict, probability: null, def };
    }
    // In the inline path a check we cannot stand behind, or a finding sitting
    // near the threshold, is dropped rather than shown: a false positive there
    // interrupts every message.
    if (opts.inlineSafe && (!def.inlineEligible || Math.abs(p - def.threshold) < def.inlineMargin)) {
      return { id: def.id, label: def.label, verdict: 'undecided' as Verdict, probability: p, def };
    }
    return {
      id: def.id,
      label: def.label,
      verdict: p >= def.threshold ? 'pass' : 'fail',
      probability: p,
      def,
    };
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

async function runBatch(
  batch: Batch,
  options: ScoreRunOptions,
): Promise<ScoreRecord[]> {
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
  return batch.items.map((item) => {
    const probabilities: Partial<Record<CheckId, number>> = {};
    const gates: Record<string, number> = {};
    for (const check of CHECKS) {
      const value = answers[`${item.key}__${check.id}`];
      if (value !== undefined) probabilities[check.id] = value;
    }
    for (const gate of GATES) {
      const value = answers[`${item.key}__${gate.id}`];
      if (value !== undefined) gates[gate.id] = value;
    }
    return { hash: item.input.hash, ts: now, probabilities, gates, model: MODEL };
  });
}

/** Score many prompts. Batches that fail are dropped, not retried forever. */
export async function scoreMany(
  inputs: ScoreInput[],
  options: ScoreRunOptions = {},
): Promise<ScoreRecord[]> {
  const batches = planBatches(inputs);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 6, batches.length || 1));
  const results: ScoreRecord[] = [];
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      const batch = batches[index];
      if (!batch) return;
      try {
        results.push(...(await runBatch(batch, options)));
      } catch {
        // Fail open: this slice of the backfill is simply missing.
      }
      done += 1;
      options.onProgress?.(done, batches.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/** Score a single prompt. Used by /jevpromptcoach:score and by `always` mode. */
export async function scoreOne(
  text: string,
  hash: string,
  options: { timeoutMs?: number; inlineSafe?: boolean } = {},
): Promise<{ record: ScoreRecord; result: PromptScore } | null> {
  const clamped = clampPrompt(text);
  const answers = await tryAsk(
    { messages: [{ id: 'm0', text: clamped }] },
    questionsFor('m0'),
    { timeoutMs: options.timeoutMs ?? 20_000 },
  );
  if (!answers) return null;

  const probabilities: Partial<Record<CheckId, number>> = {};
  const gates: Record<string, number> = {};
  for (const check of CHECKS) {
    const value = answers[`m0__${check.id}`];
    if (value !== undefined) probabilities[check.id] = value;
  }
  for (const gate of GATES) {
    const value = answers[`m0__${gate.id}`];
    if (value !== undefined) gates[gate.id] = value;
  }

  const record: ScoreRecord = { hash, ts: new Date().toISOString(), probabilities, gates, model: MODEL };
  return { record, result: interpret(hash, probabilities, gates, { inlineSafe: options.inlineSafe }) };
}

export { CHECK_BY_ID };
