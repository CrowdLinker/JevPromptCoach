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
 * tests need them — is named in ALLOWED below. The allowance deliberately lives
 * here rather than in the file itself: a file that can exempt itself with a
 * magic comment is a file an attacker, or a careless paste, can exempt too. An
 * earlier version worked that way and this doc comment alone was enough to
 * exempt this script from its own scan. Changing the list is a reviewable diff.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const staged = process.argv.includes('--staged');

/** Files that must never be tracked, whatever they contain. */
const FORBIDDEN_PATHS = [
  { re: /(^|\/)\.env(\.|$)/, why: 'environment file — may hold a TypeSafe API key' },
  { re: /^test\/fixtures\/prompts\.json$/, why: 'eval fixtures — real prompts from real work' },
  { re: /^test\/eval-raw\.json$/, why: 'raw eval output — derived from private fixtures' },
  {
    re: /^test\/fixtures\/conversations\.json$/,
    why: 'conversation fixtures — real prompts and agent replies from real work',
  },
  { re: /^test\/eval-conversations-raw\.json$/, why: 'raw eval output — derived from private fixtures' },
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
  if (/[()[\]{}$<>]/.test(value)) return false; // it is an expression, not a literal
  if (value.includes('..') || value.endsWith('.')) return false;
  // SCREAMING_SNAKE_CASE is an env var name or a constant, not a secret:
  // An apiKey field whose value is TYPESAFE_API_KEY names the variable that
  // holds the key, not the key itself. Written out rather than shown as a
  // literal: third-party scanners match the literal form and report this
  // very line as a hardcoded secret.
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return false;
  return quoted || /\d/.test(value);
}

/**
 * Files permitted to contain credential-shaped strings, with the reason.
 *
 * It is empty, and the goal is to keep it empty. The redaction tests need
 * credential shapes to test against, so they assemble them from fragments at
 * runtime — no file here holds a contiguous string that looks like a key, which
 * means nothing needs exempting and GitHub's own push protection stays happy
 * too. Prefer that trick to adding an entry.
 *
 * If an entry is ever genuinely needed, it goes here rather than in a magic
 * comment inside the file: a file that can exempt itself is a file a careless
 * paste can exempt too. An earlier version worked that way, and this script's
 * own doc comment was enough to exempt it from its own scan. Every entry is
 * printed on every run.
 */
const ALLOWED = new Map([]);

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
    try {
      return git(['show', `:${path}`]);
    } catch {
      return null;
    }
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
  try {
    content = contentOf(path);
  } catch {
    continue;
  }
  if (content === null) continue;
  // Skip anything that is not text.
  if (content.includes('\u0000')) continue;
  scanned += 1;

  if (ALLOWED.has(path)) {
    allowed.push({ path, reason: ALLOWED.get(path) });
    continue;
  }

  content.split('\n').forEach((line, i) => {
    for (const { name, re } of SECRETS) {
      if (re.test(line)) problems.push({ path, line: i + 1, what: `looks like a ${name}` });
    }
    if (looksLikeAssignedSecret(line)) {
      problems.push({ path, line: i + 1, what: 'looks like a secret assigned to a KEY/TOKEN/SECRET/PASSWORD name' });
    }
  });
}

// The ignore rules are themselves part of the guarantee, so verify they hold.
for (const mustIgnore of [
  'test/fixtures/prompts.json',
  'test/fixtures/conversations.json',
  'test/eval-raw.json',
  'test/eval-conversations-raw.json',
  '.env',
]) {
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
  - A deliberate test fixture: add the path to ALLOWED in scripts/check-leaks.mjs,
    with a reason. That is a reviewable change, which is the point.

Do not pass --no-verify. CI runs this same scan and will fail the pull request.
`);
process.exit(1);
