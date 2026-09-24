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
import type { Turn } from './conversation.js';
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

/**
 * How a prompt is judged. `alone` is the original check set. `prompts` adds
 * earlier session prompts as context under the same criteria. `conversation`
 * adds the agent's replies too, and switches to each check's conversation
 * criteria and thresholds.
 */
export type Mode = 'alone' | 'prompts' | 'conversation';

/** Keep the head and tail: a verification command is often the last line. */
export function clampPrompt(text: string): string {
  if (text.length <= MAX_PROMPT_CHARS) return text;
  return `${text.slice(0, MAX_PROMPT_CHARS - 1000)}\n…\n${text.slice(-1000)}`;
}

function scopeFor(id: string, contextIds: string[], mode: Mode): string {
  const ids = contextIds.map((c) => `"${c}"`).join(', ');
  if (mode === 'conversation' && contextIds.length) {
    return `Judge only the message with id "${id}" in the state: the developer's latest prompt to a coding agent. The messages ${ids} are the conversation before it, in order, and "role" says whether the developer or the agent wrote each. They are context and are not themselves being judged.`;
  }
  if (contextIds.length) {
    return `Judge only the message with id "${id}" in the state. The messages ${ids} are earlier prompts from the same conversation, given as context: anything they already state counts as known to the reader of "${id}", but they are not themselves being judged.`;
  }
  return `Consider only the message with id "${id}" in the state.`;
}

/**
 * @param contextIds Earlier messages that are in the state as background.
 *   Only `id` is judged.
 */
function questionsFor(id: string, contextIds: string[] = [], mode: Mode = 'alone'): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = {};
  const scope = scopeFor(id, contextIds, mode);
  for (const gate of GATES) {
    questions[`${id}__${gate.id}`] = {
      type: 'noul',
      instructions: `${scope} ${gate.instructions}`,
      criteria: gate.criteria,
    };
  }
  for (const check of CHECKS) {
    const def = mode === 'conversation' ? check.conversation : check;
    questions[`${id}__${check.id}`] = {
      type: 'noul',
      instructions: `${scope} ${def.instructions}`,
      criteria: def.criteria,
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
  /** The conversation before this prompt, when it is judged in conversation. */
  conversation?: Turn[];
}

/** A type alias rather than an interface, so it satisfies the SDK's JSON state type. */
type StateMessage = { id: string; text: string } | { id: string; role: Turn['role']; text: string };

/** The state messages for one prompt: its conversation, then the prompt as `key`. */
function messagesFor(key: string, input: ScoreInput): StateMessage[] {
  const turns = (input.conversation ?? []).map((t, i) => ({
    id: `${key}c${i + 1}`,
    role: t.role,
    text: clampPrompt(t.text),
  }));
  if (turns.length === 0) return [{ id: key, text: clampPrompt(input.text) }];
  return [...turns, { id: key, role: 'developer', text: clampPrompt(input.text) }];
}

function questionsForInput(key: string, messages: StateMessage[]): Record<string, NoulQuestion> {
  const contextIds = messages.slice(0, -1).map((m) => m.id);
  return questionsFor(key, contextIds, contextIds.length ? 'conversation' : 'alone');
}

interface Batch {
  items: { key: string; input: ScoreInput; messages: StateMessage[] }[];
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
    const messages = messagesFor(key, input);
    const itemStateTokens = messages.reduce((sum, m) => sum + estimateTokens(m.text) + 12, 0);
    const itemTokens = itemStateTokens + questionTokens(questionsForInput(key, messages));

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

    current.items.push({ key, input, messages });
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
  opts: { inlineSafe?: boolean; mode?: Mode } = {},
): PromptScore {
  const checks = CHECKS.map((def): CheckResult => {
    const gate = def.appliesWhen;
    if (gate) {
      const gateValue = gates[gate.gate];
      if (gateValue === undefined || gateValue < gate.minProbability) {
        return { id: def.id, label: def.label, verdict: 'n/a', probability: null, def };
      }
    }
    // Conversation scores are calibrated separately from the standalone ones.
    const { threshold, inlineEligible } = opts.mode === 'conversation' ? def.conversation : def;
    const p = probabilities[def.id];
    if (p === undefined) {
      return { id: def.id, label: def.label, verdict: 'undecided', probability: null, def };
    }
    // In the inline path a check we cannot stand behind, or a finding sitting
    // near the threshold, is dropped rather than shown: a false positive there
    // interrupts every message.
    if (opts.inlineSafe && (!inlineEligible || Math.abs(p - threshold) < def.inlineMargin)) {
      return { id: def.id, label: def.label, verdict: 'undecided', probability: p, def };
    }
    return { id: def.id, label: def.label, verdict: p >= threshold ? 'pass' : 'fail', probability: p, def };
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
  const state = { messages: batch.items.flatMap((item) => item.messages) };
  const questions: Record<string, NoulQuestion> = {};
  for (const item of batch.items) Object.assign(questions, questionsForInput(item.key, item.messages));

  const answers = await ask(state, questions, {
    timeoutMs: options.timeoutMs ?? 60_000,
    onUsage: options.onUsage,
  });

  const now = new Date().toISOString();
  return batch.items.map((item) => {
    const record = unpack(answers, item.key, item.input.hash, now);
    const turns = item.input.conversation?.length ?? 0;
    if (turns) Object.assign(record, { context: turns, conversation: true });
    return record;
  });
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
 * `context` is earlier prompts from the same session, oldest first; with
 * `conversation`, the agent's replies ride along too and the conversation
 * criteria apply. Either way the text must already be through the configured
 * privacy level. Context is sent but not scored.
 */
export async function scoreOne(
  text: string,
  hash: string,
  options: { timeoutMs?: number; inlineSafe?: boolean; context?: string[]; conversation?: Turn[] } = {},
): Promise<{ record: ScoreRecord; result: PromptScore } | null> {
  let messages: StateMessage[];
  let mode: Mode;
  if (options.conversation?.length) {
    messages = messagesFor('m0', { hash, text, conversation: options.conversation });
    mode = 'conversation';
  } else {
    const context = (options.context ?? []).map((t, i) => ({ id: `c${i + 1}`, text: clampPrompt(t) }));
    messages = [...context, { id: 'm0', text: clampPrompt(text) }];
    mode = context.length ? 'prompts' : 'alone';
  }
  const contextIds = messages.slice(0, -1).map((m) => m.id);
  const answers = await tryAsk({ messages }, questionsFor('m0', contextIds, mode), {
    timeoutMs: options.timeoutMs ?? 20_000,
  });
  if (!answers) return null;

  const record = unpack(answers, 'm0', hash, new Date().toISOString());
  if (contextIds.length) record.context = contextIds.length;
  if (mode === 'conversation') record.conversation = true;
  return { record, result: interpret(hash, record.probabilities, record.gates, { ...options, mode }) };
}
