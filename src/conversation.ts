/**
 * Conversations: the developer's prompts with the agent's replies between
 * them, read from Claude Code's own transcript.
 *
 * Only the agent's visible text survives, and only what it wrote after its
 * last tool call in the turn: the answer it gave or the question it ended on.
 * Tool calls, tool output, thinking and subagent traffic never leave this
 * module. An exchange whose prompt was bypassed, or was not typed by the
 * developer at all, is dropped together with its reply, because the reply can
 * repeat whatever the bypassed prompt held.
 */
import { closeSync, createReadStream, fstatSync, openSync, readSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { promptHash } from './hash.js';
import {
  isHumanPrompt,
  listTranscripts,
  PROJECTS_DIR,
  stripPreamble,
  textOf,
  type TranscriptRecord,
} from './history.js';
import { type SkipReason, skipReason } from './skip.js';

export interface Exchange {
  /** The developer's prompt, attachment preamble removed. */
  prompt: string;
  /** Hash of the prompt exactly as submitted, to recognise the one being scored. */
  hash: string;
  /** The agent's closing text for the turn; empty if it wrote none. */
  reply: string;
  ts: string;
  session: string;
}

export interface Turn {
  role: 'developer' | 'agent';
  text: string;
}

/** The end of a reply is where its answer or its question is. */
const MAX_REPLY_CHARS = 1_500;

/** Transcript lines carry whole tool outputs; 1 MB still covers the last few turns. */
const TAIL_BYTES = 1024 * 1024;

/** Prompts that are not the developer talking, or that must not be shown to anyone. */
const EXCLUDED: ReadonlySet<SkipReason> = new Set([
  'bypass_prefix',
  'slash_command',
  'command_wrapper',
  'session_meta',
]);

function clampReply(text: string): string {
  return text.length <= MAX_REPLY_CHARS ? text : `…\n${text.slice(-(MAX_REPLY_CHARS - 2))}`;
}

function hasToolUse(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_use')
  );
}

/** Feed transcript records in order; read `exchanges` after `close()`. */
class ExchangeBuilder {
  readonly exchanges: Exchange[] = [];
  private current: (Exchange & { excluded: boolean }) | null = null;
  private parts: string[] = [];

  private readonly bypassPrefix: string;

  constructor(bypassPrefix: string) {
    this.bypassPrefix = bypassPrefix;
  }

  add(record: TranscriptRecord): void {
    if (record.isSidechain) return;
    if (isHumanPrompt(record)) {
      this.close();
      const raw = textOf(record.message?.content);
      const prompt = stripPreamble(raw);
      const reason = skipReason(prompt || raw, this.bypassPrefix);
      this.current = {
        prompt,
        hash: promptHash(raw),
        reply: '',
        ts: record.timestamp ?? '',
        session: record.sessionId ?? '',
        excluded: !prompt || (reason !== null && EXCLUDED.has(reason)),
      };
      return;
    }
    if (record.type !== 'assistant' || !this.current) return;
    const content = record.message?.content;
    // Text written before a tool call is narration ("let me check"); only what
    // follows the last one is the reply the developer answered.
    if (hasToolUse(content)) this.parts = [];
    const text = textOf(content).trim();
    if (text) this.parts.push(text);
  }

  close(): void {
    if (this.current && !this.current.excluded) {
      const { prompt, hash, ts, session } = this.current;
      this.exchanges.push({ prompt, hash, ts, session, reply: clampReply(this.parts.join('\n\n')) });
    }
    this.current = null;
    this.parts = [];
  }
}

function readTail(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function parseLine(line: string): TranscriptRecord | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as TranscriptRecord;
  } catch {
    return null;
  }
}

/**
 * The last `count` exchanges before the prompt being scored, flattened into
 * turns, oldest first. Reads only the tail of the transcript. The prompt being
 * scored may or may not be in the transcript yet when the hook runs; it is
 * recognised by hash and left out either way.
 */
export function recentTurns(transcriptPath: string, currentHash: string, count: number, bypassPrefix: string): Turn[] {
  const builder = new ExchangeBuilder(bypassPrefix);
  // The first line may be cut by the tail boundary; it fails to parse and is skipped.
  for (const line of readTail(transcriptPath).split('\n')) {
    const record = parseLine(line);
    if (record) builder.add(record);
  }
  builder.close();

  const exchanges = builder.exchanges;
  if (exchanges.at(-1)?.hash === currentHash) exchanges.pop();
  return toTurns(exchanges.slice(-count));
}

export function toTurns(exchanges: Exchange[]): Turn[] {
  return exchanges.flatMap((e): Turn[] =>
    e.reply
      ? [
          { role: 'developer', text: e.prompt },
          { role: 'agent', text: e.reply },
        ]
      : [{ role: 'developer', text: e.prompt }],
  );
}

/** Every session in the local history as its list of exchanges. Local only. */
export async function readConversations(bypassPrefix: string, dir = PROJECTS_DIR): Promise<Exchange[][]> {
  const sessions: Exchange[][] = [];
  for (const file of listTranscripts(dir)) {
    const builder = new ExchangeBuilder(bypassPrefix);
    const stream = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const record = parseLine(line);
        if (record) builder.add(record);
      }
    } catch {
      continue;
    } finally {
      lines.close();
      stream.destroy();
    }
    builder.close();
    if (builder.exchanges.length > 1) sessions.push(builder.exchanges);
  }
  return sessions;
}
