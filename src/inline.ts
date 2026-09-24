/**
 * The `always` mode one-liner. Split out of hook.ts so that on-demand mode
 * never loads it, and with it never loads the Jev client.
 */
import { CHECKS } from './checks.js';
import { type Config, sessionContextEnabled, sessionRepliesEnabled } from './config.js';
import { clampReply, recentTurns, type Turn } from './conversation.js';
import { appendScores, readScores, recentSessionPrompts } from './log.js';
import { applyPrivacy } from './redact.js';
import { clampPrompt, interpret, type PromptScore, scoreOne } from './score.js';

/** Earlier prompts from the session sent with a follow-up. */
const CONTEXT_PROMPTS = 2;
/** Earlier prompt-and-reply exchanges sent with a follow-up when replies are on. */
const CONTEXT_EXCHANGES = 2;

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

interface SessionContext {
  /** Earlier prompts only, judged under the standalone criteria. */
  prompts: string[];
  /** Earlier prompts and the agent's replies, judged under the conversation criteria. */
  conversation: Turn[];
}

const NO_CONTEXT: SessionContext = { prompts: [], conversation: [] };

/**
 * What came before this prompt in the session, every piece re-run through the
 * privacy level: a prompt logged under `raw`, and every agent reply, must
 * still be redacted if the level is now `redact`. Empty for the first prompt
 * of a session, which is judged alone because it has to carry everything the
 * agent needs.
 */
function sessionContext(config: Config, at: InlineAt): SessionContext {
  if (at.session === 'unknown' || !sessionContextEnabled()) return NO_CONTEXT;
  // Redacted whole, then clamped: a cut made first can split a credential into
  // a fragment no rule recognises. Redaction is linear, so the whole text is
  // cheap; src/redact.ts bounds every quantifier for that reason.
  const safe = (text: string, clamp: (t: string) => string = clampPrompt): string | null => {
    const redacted = applyPrivacy(text, config.privacy).text;
    return redacted === null ? null : clamp(redacted);
  };
  if (sessionRepliesEnabled() && at.transcriptPath) {
    try {
      const conversation = recentTurns(at.transcriptPath, at.promptKey, CONTEXT_EXCHANGES, config.bypassPrefix)
        .map((turn) => ({ role: turn.role, text: safe(turn.text, turn.role === 'agent' ? clampReply : clampPrompt) }))
        .filter((turn): turn is Turn => turn.text !== null);
      return { prompts: [], conversation };
    } catch {
      /* transcript unreadable: fall back to the earlier prompts in the log */
    }
  }
  try {
    const prompts = recentSessionPrompts(at.session, at.ts, CONTEXT_PROMPTS)
      .map((entry) => (entry.text === null ? null : safe(entry.text)))
      .filter((text): text is string => text !== null);
    return { prompts, conversation: [] };
  } catch {
    return NO_CONTEXT;
  }
}

interface InlineAt {
  session: string;
  ts: string;
  transcriptPath?: string | undefined;
  /** promptMatchKey of the original prompt: a hash, so no text crosses here. */
  promptKey: string;
}

/**
 * @param redactedText The prompt *after* the configured privacy level has been
 *   applied. The caller must never pass the raw prompt: this is the last hop
 *   before the API and it does no redaction of its own.
 * @param hash Content hash of the ORIGINAL text, so the cache key is stable
 *   across privacy-level changes.
 * @param at The session, submission time and transcript of this prompt, to
 *   find what came before it.
 */
export async function runInline(
  redactedText: string,
  hash: string,
  config: Config,
  at: InlineAt,
): Promise<string | null> {
  const context = sessionContext(config, at);
  const hasContext = context.prompts.length > 0 || context.conversation.length > 0;

  // A prompt whose text has not changed is never scored twice, unless it is a
  // follow-up: "commit and push" means something different in every session.
  if (!hasContext) {
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
    scoreOne(redactedText, hash, {
      timeoutMs: config.alwaysTimeoutMs,
      inlineSafe: true,
      context: context.prompts,
      conversation: context.conversation,
    }),
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
