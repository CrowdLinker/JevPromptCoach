#!/usr/bin/env node
/**
 * Refuses to let a credential or somebody's prompt text into a commit.
 *
 * Runs in three places, all of them the same code:
 *   - .githooks/pre-commit, over staged content
 *   - npm test, over everything tracked
 *   - CI on every pull request, over everything tracked
 *
 * A local hook can be skipped with --no-verify, which is why CI runs it too.
 *
 * A file that legitimately contains credential-shaped strings — the redaction
 * tests need them — declares `LEAK-SCAN-ALLOW: <reason>` in its first 30 lines.
 * Every use is printed, so an allowance cannot be quiet.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const staged = process.argv.includes('--staged');

/** Files that must never be tracked, whatever they contain. */
const FORBIDDEN_PATHS = [
  { re: /(^|\/)\.env(\.|$)/, why: 'environment file — may hold a TypeSafe API key' },
  { re: /^test\/fixtures\/prompts\.json$/, why: 'eval fixtures — real prompts from real work' },
  { re: /^test\/eval-raw\.json$/, why: 'raw eval output — derived from private fixtures' },
  { re: /\.jsonl$/, why: 'JSONL log — the prompt log is exactly this shape' },
  { re: /(^|\/)corrections\.json$/, why: 'correction records — derived from prompt pairs' },
  { re: /(^|\/)prompts\.jsonl$/, why: 'the local prompt log' },
];

/**
 * Credential shapes. Kept deliberately separate from src/redact.ts: this must
 * run with no build step and no imports, from a git hook, on a fresh clone.
 */
const SECRETS = [
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'OpenAI key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[A-Za-z0-9_-]{30,}/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{16,}/ },
  { name: 'TypeSafe API key', re: /\bapikey_[A-Za-z0-9]{16,}/ },
  { name: 'private key block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'Azure client secret', re: /(?<![\w~/])[A-Za-z0-9_.-]{4,}~[A-Za-z0-9_.~-]{16,}(?![\w])/ },
];

/**
 * A secret assigned to a name that says it is one. Kept separate because it
 * needs a second opinion: `inputTokens = cached.inputTokens` and
 * `hasKey: Boolean(apiKey())` both match the shape and neither is a secret.
 * A value is only treated as one when it is an opaque literal — no code
 * punctuation — and is either quoted or contains a digit.
 */
const ASSIGNED = /\b[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)S?\s*[:=]\s*(['"]?)([^\s'"`,;]{16,})\1/i;

function looksLikeAssignedSecret(line) {
  const m = ASSIGNED.exec(line);
  if (!m) return false;
  const quoted = m[1] !== '';
  const value = m[2];
  if (/[()[\]{}$<>]/.test(value)) return false;   // it is an expression, not a literal
  if (value.includes('..') || value.endsWith('.')) return false;
  // SCREAMING_SNAKE_CASE is an env var name or a constant, not a secret:
  // `apiKey: "TYPESAFE_API_KEY"` names the variable that holds the key.
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return false;
  return quoted || /\d/.test(value);
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });

function trackedFiles() {
  return git(staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR'] : ['ls-files'])
    .split('\n')
    .filter(Boolean);
}

function contentOf(path) {
  // Staged content, not the working tree — they can differ, and what gets
  // committed is what is staged.
  if (staged) {
    try { return git(['show', `:${path}`]); } catch { return null; }
  }
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

const problems = [];
const allowed = [];
let scanned = 0;

for (const path of trackedFiles()) {
  for (const { re, why } of FORBIDDEN_PATHS) {
    if (re.test(path)) problems.push({ path, line: 0, what: `must never be committed: ${why}` });
  }

  let content;
  try { content = contentOf(path); } catch { continue; }
  if (content === null) continue;
  // Skip anything that is not text.
  if (content.includes('\u0000')) continue;
  scanned += 1;

  const lines = content.split('\n');
  const header = lines.slice(0, 30).join('\n');
  const allowMatch = /LEAK-SCAN-ALLOW:\s*(.+)/.exec(header);
  if (allowMatch) {
    allowed.push({ path, reason: allowMatch[1].trim() });
    continue;
  }

  lines.forEach((line, i) => {
    for (const { name, re } of SECRETS) {
      if (re.test(line)) problems.push({ path, line: i + 1, what: `looks like a ${name}` });
    }
    if (looksLikeAssignedSecret(line)) {
      problems.push({ path, line: i + 1, what: 'looks like a secret assigned to a KEY/TOKEN/SECRET/PASSWORD name' });
    }
  });
}

// The ignore rules are themselves part of the guarantee, so verify they hold.
for (const mustIgnore of ['test/fixtures/prompts.json', 'test/eval-raw.json', '.env']) {
  try {
    git(['check-ignore', '-q', mustIgnore]);
  } catch {
    problems.push({ path: '.gitignore', line: 0, what: `does not ignore ${mustIgnore}` });
  }
}

if (allowed.length > 0) {
  console.log('Files allowed to hold credential-shaped strings:');
  for (const a of allowed) console.log(`  ${a.path} — ${a.reason}`);
  console.log('');
}

if (problems.length === 0) {
  console.log(`Leak scan clean (${scanned} files${staged ? ', staged' : ' tracked'}).`);
  process.exit(0);
}

console.error(`\nLeak scan FAILED — ${problems.length} problem(s):\n`);
for (const p of problems) {
  console.error(`  ${p.path}${p.line ? `:${p.line}` : ''}  ${p.what}`);
}
console.error(`
Nothing has been committed.

  - A real credential: remove it, then rotate it. Assume it is burned.
  - Prompt text or a log: it belongs on your machine only. See test/fixtures/README.md.
  - A deliberate test fixture: add "LEAK-SCAN-ALLOW: <why>" to the file's first 30 lines.

Do not pass --no-verify. CI runs this same scan and will fail the pull request.
`);
process.exit(1);
