/**
 * UserPromptSubmit. In on-demand mode this appends one line to a local JSONL
 * file and exits. There is no API call, no import of the Jev client, and no
 * network on this path at all.
 *
 * It never exits 2. Exit 2 on UserPromptSubmit blocks the prompt and erases
 * what the developer typed; no score is worth that. Every failure path here
 * ends in exit 0 with no output.
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { applyPrivacy } from './redact.js';
import { skipReason } from './skip.js';
import { promptHash } from './hash.js';
import { appendLog, type LogEntry } from './log.js';

interface HookInput {
  session_id?: string;
  cwd?: string;
  /** The submitted text. Claude Code 2.1.x sends `prompt`; older docs say `user_input`. */
  prompt?: string;
  user_input?: string;
}

function readStdin(): HookInput | null {
  try {
    const raw = readFileSync(0, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as HookInput;
  } catch {
    return null;
  }
}

function emitLine(line: string): void {
  // Verified on Claude Code 2.1.277: a top-level `systemMessage` on exit 0 is
  // rendered to the developer as an informational notice while the prompt
  // proceeds. stderr on a non-zero exit is NOT displayed (anthropics/claude-code#10964),
  // and exit 2 would erase the prompt. See docs/HOOK-BEHAVIOUR.md.
  process.stdout.write(JSON.stringify({ systemMessage: line }));
}

async function main(): Promise<void> {
  const input = readStdin();
  if (!input) return;

  const text = (input.prompt ?? input.user_input ?? '').trim();
  if (!text) return;

  const config = loadConfig();
  if (skipReason(text, config.bypassPrefix) !== null) return;

  const hash = promptHash(text);
  const { text: stored, features } = applyPrivacy(text, config.privacy);

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    session: input.session_id ?? 'unknown',
    hash,
    text: stored,
    features,
    source: 'hook',
    project: input.cwd?.split('/').filter(Boolean).pop(),
  };

  try {
    appendLog(entry);
  } catch {
    // A log we cannot write is not a reason to disturb the session.
  }

  if (config.mode !== 'always') return;

  // `metadata_only` means no prompt text may leave the machine, and scoring
  // needs text. There is nothing to send, so nothing is sent.
  if (stored === null) return;

  // From here on we are in `always` mode and may call the API. What goes out is
  // `stored` — the text after the configured privacy level has been applied —
  // never the raw prompt. The budget is hard: whatever has not answered by then
  // is abandoned and nothing prints.
  const { runInline } = await import('./inline.js');
  const line = await runInline(stored, hash, config);
  if (line) emitLine(line);
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
