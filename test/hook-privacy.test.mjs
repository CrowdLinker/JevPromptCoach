/**
 * The promise this file defends: in `always` mode the hook sends the prompt
 * *after* redaction, never the raw text, and under `metadata_only` it sends
 * nothing at all.
 *
 * This is checked at the wire, not at the function boundary, because the bug it
 * exists to catch was exactly a caller passing the raw string to a function that
 * does no redaction of its own. Asserting on redact() alone would have passed.
 *
 * No API key and no network: the hook is pointed at a local capture server.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Assembled at runtime: no file here holds a contiguous credential-shaped
// string, so nothing in this repository trips a secret scanner. The value the
// hook sees is identical.
const SECRET = ['sk-', 'ant-', 'api03-', 'AAAABBBBCCCCDDDDEEEEFFFF1234'].join('');
const PROMPT = `Deploy with ${SECRET} from /Users/someone/clients/acme/app/main.ts and mail bob@acme.com`;

let server;
let captured;
let port;
/** What the capture server answers for each question id. */
let answerFor = () => 0.01;

before(async () => {
  captured = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      try {
        captured.push(JSON.parse(body));
      } catch {
        captured.push({ unparsed: body });
      }
      const parsed = JSON.parse(body);
      const answers = {};
      for (const k of Object.keys(parsed.questions ?? {})) answers[k] = { type: 'noul', noul: answerFor(k) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'test', answers, usage: { input_tokens: 1, output_tokens: 0 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => server?.close());

/**
 * Must be async: the capture server runs in this process, so a synchronous
 * spawn would block the event loop and the server could never accept the
 * hook's connection.
 */
function runHook(privacy, prompt = PROMPT, { log = [], env = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jpc-test-'));
  mkdirSync(join(home, '.claude', 'jevpromptcoach'), { recursive: true });
  if (log.length) {
    writeFileSync(
      join(home, '.claude', 'jevpromptcoach', 'prompts.jsonl'),
      log.map((e) => JSON.stringify({ features: {}, source: 'hook', ...e })).join('\n') + '\n',
    );
  }
  writeFileSync(join(home, '.claude', 'jevpromptcoach', '.env'), 'TYPESAFE_API_KEY=not-a-real-key\n');
  writeFileSync(
    join(home, '.claude', 'jevpromptcoach', 'config.json'),
    JSON.stringify({ mode: 'always', privacy, setupComplete: true, alwaysTimeoutMs: 8000, bypassPrefix: '*' }),
  );
  const child = spawn(process.execPath, ['dist/hook.js'], {
    env: {
      ...process.env,
      JEVPROMPTCOACH_SESSION_CONTEXT: '',
      ...env,
      HOME: home,
      TYPESAFE_BASE_URL: `http://127.0.0.1:${port}`,
    },
  });
  let stdout = '';
  child.stdout.on('data', (c) => {
    stdout += c;
  });
  child.stdin.end(JSON.stringify({ session_id: 's', cwd: '/tmp/d', hook_event_name: 'UserPromptSubmit', prompt }));
  return new Promise((resolve) => {
    child.on('close', (status) => {
      rmSync(home, { recursive: true, force: true });
      resolve({ status, stdout });
    });
  });
}

test('always mode sends the redacted prompt, never the raw one', async () => {
  captured.length = 0;
  const result = await runHook('redact');
  assert.equal(result.status, 0, 'hook must always exit 0');
  assert.equal(captured.length, 1, 'expected exactly one request');

  const sent = JSON.stringify(captured[0]);
  assert.ok(!sent.includes(SECRET), 'the API key reached the wire');
  assert.ok(!sent.includes('bob@acme.com'), 'the email reached the wire');
  assert.ok(!sent.includes('clients/acme'), 'the client path reached the wire');
  assert.ok(sent.includes('main.ts'), 'the filename should survive redaction');
});

/**
 * A follow-up carries the two prompts before it in the same session. They are
 * written to the log as raw text, as if captured under `raw`, so the test also
 * proves they are redacted again on the way out under `redact`.
 */
const EARLIER = [
  { ts: '2026-01-01T00:00:00.000Z', session: 's', hash: 'h0', text: 'oldest prompt, beyond the window' },
  { ts: '2026-01-01T00:01:00.000Z', session: 'other', hash: 'hx', text: 'a prompt from another session' },
  { ts: '2026-01-01T00:02:00.000Z', session: 's', hash: 'h1', text: `Mail bob@acme.com about ${SECRET}` },
  { ts: '2026-01-01T00:03:00.000Z', session: 's', hash: 'h2', text: 'Open /Users/someone/clients/acme/app/main.ts' },
];

test('a follow-up sends the two earlier prompts, redacted, and scores only the last', async () => {
  captured.length = 0;
  const result = await runHook('redact', 'Now commit and push all of it', { log: EARLIER });
  assert.equal(result.status, 0);
  assert.equal(captured.length, 1);

  const { state, questions } = captured[0];
  const texts = state.messages.map((m) => m.text);
  assert.equal(texts.length, 3, 'two context prompts plus the one being scored');
  assert.equal(state.messages.at(-1).id, 'm0');
  assert.equal(texts.at(-1), 'Now commit and push all of it');
  assert.ok(!texts.some((t) => t.includes('oldest') || t.includes('another session')));

  const sent = JSON.stringify(captured[0]);
  assert.ok(!sent.includes(SECRET), 'a context prompt leaked the API key');
  assert.ok(!sent.includes('bob@acme.com'), 'a context prompt leaked the email');
  assert.ok(!sent.includes('clients/acme'), 'a context prompt leaked the client path');
  assert.ok(sent.includes('main.ts'));

  assert.ok(
    Object.keys(questions).every((k) => k.startsWith('m0__')),
    'context prompts must not be scored',
  );
});

test('the first prompt of a session is scored on its own', async () => {
  captured.length = 0;
  const log = EARLIER.filter((e) => e.session === 'other');
  await runHook('redact', 'Now commit and push all of it', { log });
  assert.equal(captured[0].state.messages.length, 1);
});

test('JEVPROMPTCOACH_SESSION_CONTEXT=0 turns the context off', async () => {
  captured.length = 0;
  await runHook('redact', 'Now commit and push all of it', {
    log: EARLIER,
    env: { JEVPROMPTCOACH_SESSION_CONTEXT: '0' },
  });
  assert.equal(captured[0].state.messages.length, 1);
});

test('a score of 0 is not shown, only what is missing', async () => {
  answerFor = () => 0.01;
  const { systemMessage } = JSON.parse((await runHook('redact')).stdout);
  assert.ok(!systemMessage.includes('/100'), systemMessage);
  assert.match(systemMessage, /^Jev \(Prompt Coach\)\nMissing: /);
});

test('a score above 0 is shown', async () => {
  answerFor = (k) => (k.endsWith('__named_target') ? 0.99 : 0.01);
  try {
    const { systemMessage } = JSON.parse((await runHook('redact')).stdout);
    assert.match(systemMessage, /^Jev \(Prompt Coach\) - \d+\/100\nMissing: /);
  } finally {
    answerFor = () => 0.01;
  }
});

test('metadata_only sends nothing at all', async () => {
  captured.length = 0;
  const result = await runHook('metadata_only');
  assert.equal(result.status, 0, 'hook must always exit 0');
  assert.equal(captured.length, 0, 'metadata_only must make no request');
});

test('the hook never exits non-zero, even with unusable input', async () => {
  for (const input of ['', 'not json', '{}', '{"prompt":""}']) {
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['dist/hook.js']);
      let stdout = '';
      child.stdout.on('data', (c) => {
        stdout += c;
      });
      child.stdin.end(input);
      child.on('close', (status) => resolve({ status, stdout }));
    });
    assert.equal(r.status, 0, `exit ${r.status} on input ${JSON.stringify(input)}`);
    assert.equal(r.stdout, '', 'nothing should be printed');
  }
});
