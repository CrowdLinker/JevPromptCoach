/**
 * The only network dependency. Everything here fails open: a caller that gets
 * `null` back prints nothing and exits 0. No error from this module ever
 * carries the API key, including the SDK's own error messages.
 *
 * Types come from the SDK rather than from a copy kept here, so a wire-format
 * change surfaces as a type error in this file instead of a silent mismatch.
 * Type imports are erased at build time; nothing on the hook path loads the SDK.
 */
import type { EntryType, NoulQuestion as SdkNoulQuestion, Usage } from '@typesafe-ai/sdk';
import { apiKey } from './config.js';

export const MODEL = 'jev-latest';

/**
 * The SDK accepts structured instructions and criteria. This plugin only ever
 * sends text, and the token estimate in src/score.ts relies on that.
 */
export interface NoulQuestion extends SdkNoulQuestion {
  instructions: string;
  criteria: { true: string; false: string };
}

export type { Usage };

export class JevUnavailable extends Error {}

/**
 * The SDK is imported lazily. In on-demand mode the hook never reaches this
 * module, so the cost of loading the client is never paid on the prompt path.
 */
async function client(timeoutMs: number) {
  const key = apiKey();
  if (!key) throw new JevUnavailable('TYPESAFE_API_KEY is not set');
  const { TypeSafeClient } = await import('@typesafe-ai/sdk');
  return new TypeSafeClient({
    apiKey: key,
    defaultModel: MODEL,
    timeout: timeoutMs,
    logLevel: 'error',
    retry: { maxRetries: 2 },
  });
}

/**
 * Scrub anything that could carry the key out of an error before it is shown.
 * The SDK redacts credential headers in its own logs, but an error thrown by
 * fetch can still quote a URL or a header we built, so this is belt and braces.
 */
function safeMessage(err: unknown): string {
  const key = apiKey();
  let msg = err instanceof Error ? err.message : String(err);
  if (key && key.length > 4) msg = msg.split(key).join('[REDACTED]');
  return msg.replace(/\b(sk-[A-Za-z0-9_-]+|Bearer\s+\S+)/g, '[REDACTED]').slice(0, 300);
}

export interface AskOptions {
  timeoutMs?: number;
  /** Called with the token usage of each successful request. */
  onUsage?: ((usage: Usage) => void) | undefined;
}

/**
 * One request, many questions. Jev reads the state once and answers every
 * question against it in parallel, so a full seven-check evaluation costs
 * about what a single question costs.
 */
export async function ask(
  state: EntryType,
  questions: Record<string, NoulQuestion>,
  options: AskOptions = {},
): Promise<Record<string, number>> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const c = await client(timeoutMs);
  try {
    const result = await c.systemOne({ state, questions, model: MODEL });

    options.onUsage?.(result.usage);

    // The type promises a number for every answer; the wire does not have to keep it.
    const out: Record<string, number> = {};
    for (const [id, answer] of Object.entries(result.answers)) {
      if (typeof answer?.noul === 'number') out[id] = answer.noul;
    }
    return out;
  } catch (err) {
    throw new JevUnavailable(safeMessage(err));
  }
}

/** `ask`, but never throws. Returns null on any failure. */
export async function tryAsk(
  state: EntryType,
  questions: Record<string, NoulQuestion>,
  options: AskOptions = {},
): Promise<Record<string, number> | null> {
  try {
    return await ask(state, questions, options);
  } catch {
    return null;
  }
}

/** $ per input token. Output tokens are free. See https://docs.typesafe.ai/models */
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export function estimateTokens(text: string): number {
  // Jev bills input tokens; ~3.6 chars/token is a close enough estimate for a
  // pre-flight cost quote on English prose and code.
  return Math.ceil(text.length / 3.6);
}
