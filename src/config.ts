import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

export type Mode = 'on-demand' | 'always';
export type Privacy = 'redact' | 'metadata_only' | 'raw';

export interface Config {
  mode: Mode;
  privacy: Privacy;
  /** Set once the first-run prompt has been answered. */
  setupComplete: boolean;
  /** ISO date of the last backfill, or null if never run. */
  lastBackfill: string | null;
  /** Hard ceiling on the wall-clock a scoring call may take in `always` mode. */
  alwaysTimeoutMs: number;
  /** A prompt starting with this string is never scored or logged. */
  bypassPrefix: string;
}

export const DEFAULT_CONFIG: Config = {
  mode: 'on-demand',
  privacy: 'redact',
  setupComplete: false,
  lastBackfill: null,
  alwaysTimeoutMs: 4000,
  bypassPrefix: '*',
};

export const DATA_DIR = join(homedir(), '.claude', 'jevpromptcoach');
export const CONFIG_PATH = join(DATA_DIR, 'config.json');
export const LOG_PATH = join(DATA_DIR, 'prompts.jsonl');
export const CACHE_PATH = join(DATA_DIR, 'scores.jsonl');
export const STATE_PATH = join(DATA_DIR, 'state.json');
export const CORRECTIONS_PATH = join(DATA_DIR, 'corrections.json');

export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config>;
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Config): void {
  ensureDataDir();
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}

export const ENV_PATH = join(DATA_DIR, '.env');

/**
 * The API key. Never written to config.json, never echoed, never allowed into
 * an error message.
 *
 * The environment comes first. The key file is a fallback because a hook does
 * not run under the developer's shell profile: a key exported in .zshrc is not
 * necessarily visible to the hook process, and `always` mode needs it there.
 * The file is created 0600 and is the developer's to delete.
 */
export function apiKey(): string | null {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const match = /^\s*TYPESAFE_API_KEY\s*=\s*(.+?)\s*$/m.exec(readFileSync(ENV_PATH, 'utf8'));
    const key = match?.[1]?.replace(/^['"]|['"]$/g, '').trim();
    return key ? key : null;
  } catch {
    return null;
  }
}

/**
 * Where the key was found, for reporting. Never returns the key itself.
 * `null` means no key is available and nothing can be scored.
 */
export function apiKeySource(): 'environment' | 'key file' | null {
  if (process.env.TYPESAFE_API_KEY?.trim()) return 'environment';
  return apiKey() ? 'key file' : null;
}

/** Store the key at 0600 for the hook process to read. Never logs it. */
export function saveApiKey(key: string): void {
  ensureDataDir();
  writeFileSync(ENV_PATH, `TYPESAFE_API_KEY=${key.trim()}\n`, { mode: 0o600 });
}
