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
import { clampPrompt } from './score.js';
import type { LogEntry } from './log.js';

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

export interface CorrectionRecord {
  hash: string;
  corrected: boolean;
  probability: number;
}

/** Consecutive same-session prompt pairs, in order. */
export function buildPairs(entries: LogEntry[]): Pair[] {
  const bySession = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    if (entry.text === null) continue; // metadata_only carries no text to compare
    const list = bySession.get(entry.session);
    if (list) list.push(entry); else bySession.set(entry.session, [entry]);
  }

  const pairs: Pair[] = [];
  for (const list of bySession.values()) {
    list.sort((a, b) => a.ts.localeCompare(b.ts));
    for (let i = 0; i + 1 < list.length; i += 1) {
      const first = list[i]!;
      const second = list[i + 1]!;
      const gap = Date.parse(second.ts) - Date.parse(first.ts);
      if (!Number.isFinite(gap) || gap < 0 || gap > MAX_PAIR_GAP_MS) continue;
      pairs.push({
        hash: first.hash,
        first: clampPrompt(first.text!),
        second: clampPrompt(second.text!),
      });
    }
  }
  return pairs;
}

function planPairBatches(pairs: Pair[]): Pair[][] {
  const perQuestion = estimateTokens(
    CORRECTION_QUESTION.instructions + CORRECTION_QUESTION.criteria.true + CORRECTION_QUESTION.criteria.false,
  );
  const batches: Pair[][] = [];
  let current: Pair[] = [];
  let tokens = 0;

  for (const pair of pairs) {
    const cost = estimateTokens(pair.first + pair.second) + perQuestion + 20;
    if (current.length > 0 && (current.length >= MAX_PAIRS_PER_REQUEST || tokens + cost > REQUEST_TOKEN_BUDGET)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(pair);
    tokens += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface CorrectionOptions {
  concurrency?: number;
  onUsage?: (usage: Usage) => void;
  onProgress?: (done: number, total: number) => void;
}

/** Judge every pair. Failures drop out rather than aborting the run. */
export async function detectCorrections(
  pairs: Pair[],
  options: CorrectionOptions = {},
): Promise<CorrectionRecord[]> {
  const batches = planPairBatches(pairs);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 6, batches.length || 1));
  const results: CorrectionRecord[] = [];
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      const batch = batches[index];
      if (!batch) return;
      const state = {
        conversations: batch.map((pair, i) => ({
          id: `c${i}`,
          first_message: pair.first,
          second_message: pair.second,
        })),
      };
      const questions: Record<string, NoulQuestion> = {};
      batch.forEach((_, i) => {
        questions[`c${i}`] = {
          type: 'noul',
          instructions: `Consider only the conversation with id "c${i}" in the state. ${CORRECTION_QUESTION.instructions}`,
          criteria: CORRECTION_QUESTION.criteria,
        };
      });

      try {
        const answers = await ask(state, questions, { timeoutMs: 60_000, onUsage: options.onUsage });
        batch.forEach((pair, i) => {
          const p = answers[`c${i}`];
          if (p === undefined) return;
          results.push({ hash: pair.hash, corrected: p >= CORRECTION_QUESTION.threshold, probability: p });
        });
      } catch { /* this slice is missing */ }

      done += 1;
      options.onProgress?.(done, batches.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
