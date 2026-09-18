/**
 * The `always` mode one-liner. Split out of hook.ts so that on-demand mode
 * never loads it, and with it never loads the Jev client.
 */
import { CHECKS } from './checks.js';
import type { Config } from './config.js';
import { appendScores, readScores } from './log.js';
import { interpret, type PromptScore, scoreOne } from './score.js';

function format(result: PromptScore): string | null {
  // Only confident failures reach the line. `inlineSafe` has already demoted
  // anything near a threshold to `undecided`, so what is left is worth saying.
  const failures = result.checks.filter((c) => c.verdict === 'fail');
  if (failures.length === 0) return null;

  // Pick the two weakest, then put them back in check order so the sentence
  // reads the way the checks are taught rather than by probability.
  const order = new Map(CHECKS.map((c, i) => [c.id, i]));
  const worst = failures
    .toSorted((a, b) => (a.probability ?? 1) - (b.probability ?? 1))
    .slice(0, 2)
    .toSorted((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  // `shortfall` rather than `label`: the label says what the habit is, and this
  // sentence needs what is absent from the prompt.
  const missing = worst.map((c) => c.def.shortfall).join(', ');
  // Claude Code prefixes the first line with "UserPromptSubmit says:" and keeps
  // line breaks, so the score shares that line and the detail sits under it.
  const head = result.score === null ? 'Jev (Prompt Coach)' : `Jev (Prompt Coach) - ${result.score}/100`;
  return `${head}\nMissing: ${missing}.`;
}

/**
 * @param redactedText The prompt *after* the configured privacy level has been
 *   applied. The caller must never pass the raw prompt: this is the last hop
 *   before the API and it does no redaction of its own.
 * @param hash Content hash of the ORIGINAL text, so the cache key is stable
 *   across privacy-level changes.
 */
export async function runInline(redactedText: string, hash: string, config: Config): Promise<string | null> {
  // A prompt whose text has not changed is never scored twice.
  try {
    const cached = readScores().get(hash);
    if (cached) {
      return format(interpret(hash, cached.probabilities, cached.gates, { inlineSafe: true }));
    }
  } catch {
    /* cache unreadable; score it fresh */
  }

  const deadline = new Promise<null>((resolve) => {
    const timer = setTimeout(() => resolve(null), config.alwaysTimeoutMs);
    timer.unref?.();
  });

  const scored = await Promise.race([
    scoreOne(redactedText, hash, { timeoutMs: config.alwaysTimeoutMs, inlineSafe: true }),
    deadline,
  ]);
  if (!scored) return null;

  try {
    appendScores([scored.record]);
  } catch {
    /* cache write is best effort */
  }
  return format(scored.result);
}
