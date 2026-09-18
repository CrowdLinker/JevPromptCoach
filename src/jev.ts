/**
 * The only network dependency. Everything here fails open: a caller that gets
 * `null` back prints nothing and exits 0. No error from this module ever
 * carries the API key, including the SDK's own error messages.
 */
import { apiKey } from './config.js';

export const MODEL = 'jev-latest';

export interface NoulAnswer { type: 'noul'; noul: number }
export interface Usage { input_tokens: number; output_tokens: number }
export interface JevResult {
  model: string;
  answers: Record<string, NoulAnswer>;
  usage: Usage;
}

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

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
  return msg.replace(/\b(sk-[A-Za-z0-9_\-]+|Bearer\s+\S+)/g, '[REDACTED]').slice(0, 300);
}

export interface AskOptions {
  timeoutMs?: number;
  /** Called with the token usage of each successful request. */
  onUsage?: (usage: Usage) => void;
}

/**
 * One request, many questions. Jev reads the state once and answers every
 * question against it in parallel, so a full seven-check evaluation costs
 * about what a single question costs.
 */
export async function ask(
  state: unknown,
  questions: Record<string, NoulQuestion>,
  options: AskOptions = {},
): Promise<Record<string, number>> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const c = await client(timeoutMs);
  try {
    const result = (await c.systemOne({
      state: state as never,
      questions: questions as never,
      model: MODEL,
    })) as unknown as JevResult;

    options.onUsage?.(result.usage);

    const out: Record<string, number> = {};
    for (const [id, answer] of Object.entries(result.answers)) {
      if (answer && typeof answer.noul === 'number') out[id] = answer.noul;
    }
    return out;
  } catch (err) {
    throw new JevUnavailable(safeMessage(err));
  }
}

/** `ask`, but never throws. Returns null on any failure. */
export async function tryAsk(
  state: unknown,
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
