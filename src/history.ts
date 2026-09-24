/**
 * Reader for Claude Code's own transcripts under ~/.claude/projects/.
 *
 * Format as observed on Claude Code 2.1.x: one JSONL file per session, one
 * object per line. A human-typed prompt is `type: "user"` carrying
 * `promptSource: "typed"`. Older records predate that field, so they are
 * admitted on shape instead: role user, no tool_result block, not a sidechain,
 * not meta. Tool results, subagent traffic, compaction summaries and slash
 * command wrappers all arrive as `type: "user"` too and are all excluded.
 */
import { readdirSync, statSync, createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

export interface HistoryPrompt {
  ts: string;
  session: string;
  text: string;
  project: string;
}

export const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

export interface TranscriptRecord {
  type?: string;
  message?: { role?: string; content?: unknown };
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  promptSource?: string;
  userType?: string;
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
  }
  return '';
}

function hasToolResult(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result')
  );
}

export function isHumanPrompt(record: TranscriptRecord): boolean {
  if (record.type !== 'user') return false;
  if (record.isSidechain || record.isMeta) return false;
  if (hasToolResult(record.message?.content)) return false;

  const source = record.promptSource;
  // Explicitly attributed sources: only a typed prompt counts. 'system',
  // 'sdk' and 'queued' are not the developer writing a message.
  if (source !== undefined) return source === 'typed';
  // Pre-`promptSource` records: admit and let the skip rules filter the
  // command wrappers and compaction summaries out downstream.
  return true;
}

export function listTranscripts(dir = PROJECTS_DIR): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const project of readdirSync(dir)) {
    const projectDir = join(dir, project);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
      for (const file of readdirSync(projectDir)) {
        if (file.endsWith('.jsonl')) files.push(join(projectDir, file));
      }
    } catch {
      /* unreadable project dir */
    }
  }
  return files;
}

/** Strip the attachment preamble Claude Code prepends to a prompt with files. */
export function stripPreamble(text: string): string {
  return text
    .replace(/^\s*<system_instruction>[\s\S]*?<\/system_instruction>\s*/g, '')
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, '')
    .trim();
}

async function readTranscript(path: string, out: HistoryPrompt[]): Promise<void> {
  const project = path.split('/').slice(-2, -1)[0] ?? 'unknown';
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record: TranscriptRecord;
      try {
        record = JSON.parse(line) as TranscriptRecord;
      } catch {
        continue;
      }
      if (!isHumanPrompt(record)) continue;
      const text = stripPreamble(textOf(record.message?.content));
      if (!text) continue;
      out.push({
        ts: record.timestamp ?? new Date(0).toISOString(),
        session: record.sessionId ?? path,
        text,
        project,
      });
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Every human-typed prompt in the local history, oldest first. */
export async function readHistory(dir = PROJECTS_DIR): Promise<HistoryPrompt[]> {
  const prompts: HistoryPrompt[] = [];
  for (const file of listTranscripts(dir)) {
    try {
      await readTranscript(file, prompts);
    } catch {
      /* skip unreadable file */
    }
  }
  prompts.sort((a, b) => a.ts.localeCompare(b.ts));
  return prompts;
}
