/**
 * The `always` mode one-liner. Split out of hook.ts so that on-demand mode
 * never loads it, and with it never loads the Jev client.
 */
import { CHECKS } from './checks.js';
import { type Config, sessionContextEnabled } from './config.js';
import { appendScores, readScores, recentSessionPrompts } from './log.js';
import { applyPrivacy } from './redact.js';
import { interpret, type PromptScore, scoreOne } from './score.js';

/** Earlier prompts from the session sent with a follow-up. */
const CONTEXT_PROMPTS = 2;

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
  // A 0 is left off: the inline score counts only the few checks decided with
  // confidence, so 0 usually means "0 of 3" and reads as if nothing arrived.
  // What is missing is the useful part either way.
  const head = result.score ? `Jev (Prompt Coach) - ${result.score}/100` : 'Jev (Prompt Coach)';
  return `${head}\nMissing: ${missing}.`;
}

/**
 * Earlier prompts from this session, re-run through the privacy level: a
 * prompt logged under `raw` must still be redacted if the level is now
 * `redact`. Empty for the first prompt of a session, which is judged alone
 * because it has to carry everything the agent needs.
 */
function sessionContext(config: Config, session: string, ts: string): string[] {
  if (session === 'unknown' || !sessionContextEnabled()) return [];
  try {
    return recentSessionPrompts(session, ts, CONTEXT_PROMPTS)
      .map((entry) => (entry.text === null ? null : applyPrivacy(entry.text, config.privacy).text))
      .filter((text): text is string => text !== null);
  } catch {
    return [];
  }
}

/**
 * @param redactedText The prompt *after* the configured privacy level has been
 *   applied. The caller must never pass the raw prompt: this is the last hop
 *   before the API and it does no redaction of its own.
 * @param hash Content hash of the ORIGINAL text, so the cache key is stable
 *   across privacy-level changes.
 * @param at The session and submission time of this prompt, to find the
 *   prompts before it.
 */
export async function runInline(
  redactedText: string,
  hash: string,
  config: Config,
  at: { session: string; ts: string },
): Promise<string | null> {
  const context = sessionContext(config, at.session, at.ts);

  // A prompt whose text has not changed is never scored twice, unless it is a
  // follow-up: "commit and push" means something different in every session.
  if (context.length === 0) {
    try {
      const cached = readScores().get(hash);
      if (cached && !cached.context) {
        return format(interpret(hash, cached.probabilities, cached.gates, { inlineSafe: true }));
      }
    } catch {
      /* cache unreadable; score it fresh */
    }
  }

  const deadline = new Promise<null>((resolve) => {
    const timer = setTimeout(() => resolve(null), config.alwaysTimeoutMs);
    timer.unref?.();
  });

  const scored = await Promise.race([
    scoreOne(redactedText, hash, { timeoutMs: config.alwaysTimeoutMs, inlineSafe: true, context }),
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
