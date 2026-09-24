/**
 * The local prompt log, the score cache and the correction records. All three
 * live under ~/.claude/jevpromptcoach/. Nothing here ever leaves the machine;
 * the commands read it, and only a command sends anything to the API.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import type { CheckId, GateId } from './checks.js';
import { CACHE_PATH, CORRECTIONS_PATH, ensureDataDir, LOG_PATH } from './config.js';
import type { Features } from './redact.js';

export interface LogEntry {
  /** ISO timestamp of submission. */
  ts: string;
  /** Claude Code session id; consecutive entries sharing one form a pair. */
  session: string;
  /** sha256 prefix of the trimmed original text; the cache key. */
  hash: string;
  /** Redacted prompt, or null under metadata_only. */
  text: string | null;
  features: Features;
  /** 'hook' for live capture, 'backfill' for history import. */
  source: 'hook' | 'backfill';
  /** Project directory basename, for nothing more than grouping. */
  project?: string;
}

/** A log entry that kept its text: everything except a `metadata_only` capture. */
export type TextEntry = LogEntry & { text: string };

export function hasText(entry: LogEntry): entry is TextEntry {
  return entry.text !== null;
}

export interface ScoreRecord {
  hash: string;
  ts: string;
  /** Raw probability per check. Absent when the check did not apply. */
  probabilities: Partial<Record<CheckId, number>>;
  /** Raw probability per applicability gate. */
  gates: Partial<Record<GateId, number>>;
  model: string;
  /**
   * How many earlier prompts from the session rode along as context. Absent for
   * a prompt scored on its own. A score that depended on its context is not
   * served from the cache, because the same text elsewhere had other context.
   */
  context?: number;
}

/** The correction-rate verdict for the prompt with this hash. */
export interface CorrectionRecord {
  hash: string;
  corrected: boolean;
  probability: number;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/**
 * The only thing the hook does in on-demand mode. One `appendFileSync` of one
 * line; O_APPEND makes concurrent sessions safe for writes this small.
 */
export function appendLog(entry: LogEntry): void {
  ensureDataDir();
  appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export function readLog(): LogEntry[] {
  return readJsonl<LogEntry>(LOG_PATH);
}

/** Enough for dozens of recent prompts; the log is never read whole on the prompt path. */
const TAIL_BYTES = 256 * 1024;

/**
 * The last `limit` hook prompts from `session` logged before `before`, oldest
 * first. Reads only the tail of the log, so a session whose earlier prompts
 * have scrolled out of it is treated as having none.
 */
export function recentSessionPrompts(session: string, before: string, limit: number): LogEntry[] {
  if (!existsSync(LOG_PATH)) return [];
  const fd = openSync(LOG_PATH, 'r');
  let tail: string;
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    tail = buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }

  const out: LogEntry[] = [];
  // The first line may be cut mid-way by the tail boundary; it fails to parse and is skipped.
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as LogEntry;
      if (entry.source === 'hook' && entry.session === session && entry.ts < before) out.push(entry);
    } catch {
      /* torn line */
    }
  }
  return out.slice(-limit);
}

export function appendLogMany(entries: LogEntry[]): void {
  if (entries.length === 0) return;
  ensureDataDir();
  appendFileSync(LOG_PATH, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, { mode: 0o600 });
}

/** Delete the log, the score cache and the correction records. */
export function clearLocalData(): void {
  ensureDataDir();
  writeFileSync(LOG_PATH, '', { mode: 0o600 });
  writeFileSync(CACHE_PATH, '', { mode: 0o600 });
  writeFileSync(CORRECTIONS_PATH, '[]', { mode: 0o600 });
}

export function readScores(): Map<string, ScoreRecord> {
  const map = new Map<string, ScoreRecord>();
  for (const record of readJsonl<ScoreRecord>(CACHE_PATH)) map.set(record.hash, record);
  return map;
}

export function appendScores(records: ScoreRecord[]): void {
  if (records.length === 0) return;
  ensureDataDir();
  appendFileSync(CACHE_PATH, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
}

/** Rewrite the cache keeping one record per hash. Called after a large backfill. */
export function compactScores(): void {
  const records = readScores();
  if (records.size === 0) return;
  ensureDataDir();
  const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, `${[...records.values()].map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
  renameSync(tmp, CACHE_PATH);
}

/** One verdict per prompt hash. No file yet means no backfill has judged anything. */
export function readCorrections(): Map<string, CorrectionRecord> {
  const map = new Map<string, CorrectionRecord>();
  try {
    const records = JSON.parse(readFileSync(CORRECTIONS_PATH, 'utf8')) as CorrectionRecord[];
    for (const record of records) map.set(record.hash, record);
  } catch {
    /* none yet, or unreadable: either way nothing to report */
  }
  return map;
}

/** Rewritten whole; a backfill merges its new verdicts into what it read. */
export function writeCorrections(records: Iterable<CorrectionRecord>): void {
  ensureDataDir();
  writeFileSync(CORRECTIONS_PATH, JSON.stringify([...records]), { mode: 0o600 });
}

/** Entries that already carry a cached score, newest first. */
export function dedupeByHash(entries: LogEntry[]): LogEntry[] {
  const seen = new Set<string>();
  const out: LogEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.hash)) continue;
    seen.add(entry.hash);
    out.push(entry);
  }
  return out;
}
