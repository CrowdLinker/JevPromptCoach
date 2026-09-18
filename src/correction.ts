/**
 * The outcome signal (phase 1).
 *
 * Hit rates on their own are self-referential: they say a prompt matched the
 * checks, not that it worked. Correction rate is the cheapest real outcome
 * available, because it needs no completion detection — only whether the next
 * thing the developer said was "no, not like that".
 *
 * Phase 2, turns-to-completion, needs completion and topic-change detection and
 * is deliberately not here.
 */
import { CORRECTION_QUESTION } from './checks.js';
import { ask, estimateTokens, type NoulQuestion, type Usage } from './jev.js';
import { type CorrectionRecord, hasText, type LogEntry, type TextEntry } from './log.js';
import { runPool } from './pool.js';
import { clampPrompt } from './score.js';

const REQUEST_TOKEN_BUDGET = 40_000;
const MAX_PAIRS_PER_REQUEST = 30;
/** Two prompts further apart than this are not a follow-up. */
const MAX_PAIR_GAP_MS = 30 * 60 * 1000;

export interface Pair {
  /** Hash of the FIRST prompt: the one whose checks we are judging. */
  hash: string;
  first: string;
  second: string;
}

/** Consecutive same-session prompt pairs, in order. */
export function buildPairs(entries: LogEntry[]): Pair[] {
  const bySession = new Map<string, TextEntry[]>();
  for (const entry of entries) {
    if (!hasText(entry)) continue; // metadata_only carries no text to compare
    const list = bySession.get(entry.session);
    if (list) list.push(entry);
    else bySession.set(entry.session, [entry]);
  }

  const pairs: Pair[] = [];
  for (const list of bySession.values()) {
    list.sort((a, b) => a.ts.localeCompare(b.ts));
    for (const [index, first] of list.entries()) {
      const second = list[index + 1];
      if (!second) break;
      const gap = Date.parse(second.ts) - Date.parse(first.ts);
      if (!Number.isFinite(gap) || gap < 0 || gap > MAX_PAIR_GAP_MS) continue;
      pairs.push({ hash: first.hash, first: clampPrompt(first.text), second: clampPrompt(second.text) });
    }
  }
  return pairs;
}

interface PairBatch {
  pairs: Pair[];
  /** Estimated input tokens for the request: both messages of every pair, plus the question each time. */
  tokens: number;
}

function planPairBatches(pairs: Pair[]): PairBatch[] {
  const perQuestion = estimateTokens(
    CORRECTION_QUESTION.instructions + CORRECTION_QUESTION.criteria.true + CORRECTION_QUESTION.criteria.false,
  );
  const batches: PairBatch[] = [];
  let current: PairBatch = { pairs: [], tokens: 0 };

  for (const pair of pairs) {
    const cost = estimateTokens(pair.first + pair.second) + perQuestion + 20;
    const wouldOverflow =
      current.pairs.length > 0 &&
      (current.pairs.length >= MAX_PAIRS_PER_REQUEST || current.tokens + cost > REQUEST_TOKEN_BUDGET);
    if (wouldOverflow) {
      batches.push(current);
      current = { pairs: [], tokens: 0 };
    }
    current.pairs.push(pair);
    current.tokens += cost;
  }
  if (current.pairs.length > 0) batches.push(current);
  return batches;
}

/** Input tokens judging these pairs would bill, taken from the batches that would be sent. */
export function estimateCorrectionTokens(pairs: Pair[]): number {
  return planPairBatches(pairs).reduce((sum, batch) => sum + batch.tokens, 0);
}

export interface CorrectionOptions {
  concurrency?: number;
  onUsage?: (usage: Usage) => void;
  onProgress?: (done: number, total: number) => void;
}

async function judgeBatch(batch: PairBatch, options: CorrectionOptions): Promise<CorrectionRecord[]> {
  const state = {
    conversations: batch.pairs.map((pair, i) => ({
      id: `c${i}`,
      first_message: pair.first,
      second_message: pair.second,
    })),
  };
  const questions: Record<string, NoulQuestion> = {};
  batch.pairs.forEach((_, i) => {
    questions[`c${i}`] = {
      type: 'noul',
      instructions: `Consider only the conversation with id "c${i}" in the state. ${CORRECTION_QUESTION.instructions}`,
      criteria: CORRECTION_QUESTION.criteria,
    };
  });

  const answers = await ask(state, questions, { timeoutMs: 60_000, onUsage: options.onUsage });
  const records: CorrectionRecord[] = [];
  batch.pairs.forEach((pair, i) => {
    const p = answers[`c${i}`];
    if (p !== undefined)
      records.push({ hash: pair.hash, corrected: p >= CORRECTION_QUESTION.threshold, probability: p });
  });
  return records;
}

/** Judge every pair. Failures drop out rather than aborting the run. */
export async function detectCorrections(pairs: Pair[], options: CorrectionOptions = {}): Promise<CorrectionRecord[]> {
  return runPool(
    planPairBatches(pairs),
    options.concurrency ?? 6,
    (batch) => judgeBatch(batch, options),
    options.onProgress,
  );
}
