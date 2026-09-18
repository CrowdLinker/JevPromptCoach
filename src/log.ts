/**
 * The local prompt log and the score cache. Both are append-only JSONL under
 * ~/.claude/jevpromptcoach/. Nothing here ever leaves the machine; the commands
 * read it, and only a command sends anything to the API.
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { ensureDataDir, LOG_PATH, CACHE_PATH } from './config.js';
import type { Features } from './redact.js';
import type { CheckId } from './checks.js';

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

export interface ScoreRecord {
  hash: string;
  ts: string;
  /** Raw probability per check. Absent when the check did not apply. */
  probabilities: Partial<Record<CheckId, number>>;
  gates: Record<string, number>;
  model: string;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* skip a torn line */ }
  }
  return out;
}

/**
 * The only thing the hook does in on-demand mode. One `appendFileSync` of one
 * line; O_APPEND makes concurrent sessions safe for writes this small.
 */
export function appendLog(entry: LogEntry): void {
  ensureDataDir();
  appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

export function readLog(): LogEntry[] {
  return readJsonl<LogEntry>(LOG_PATH);
}

export function appendLogMany(entries: LogEntry[]): void {
  if (entries.length === 0) return;
  ensureDataDir();
  appendFileSync(LOG_PATH, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
}

export function clearLog(): void {
  ensureDataDir();
  writeFileSync(LOG_PATH, '', { mode: 0o600 });
  writeFileSync(CACHE_PATH, '', { mode: 0o600 });
}

export function readScores(): Map<string, ScoreRecord> {
  const map = new Map<string, ScoreRecord>();
  for (const record of readJsonl<ScoreRecord>(CACHE_PATH)) map.set(record.hash, record);
  return map;
}

export function appendScores(records: ScoreRecord[]): void {
  if (records.length === 0) return;
  ensureDataDir();
  appendFileSync(CACHE_PATH, records.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
}

/** Rewrite the cache keeping one record per hash. Called after a large backfill. */
export function compactScores(): void {
  const records = readScores();
  if (records.size === 0) return;
  ensureDataDir();
  const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, [...records.values()].map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  renameSync(tmp, CACHE_PATH);
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
