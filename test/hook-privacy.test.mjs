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

before(async () => {
  captured = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { captured.push(JSON.parse(body)); } catch { captured.push({ unparsed: body }); }
      const parsed = JSON.parse(body);
      const answers = {};
      for (const k of Object.keys(parsed.questions ?? {})) answers[k] = { type: 'noul', noul: 0.01 };
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
function runHook(privacy, prompt = PROMPT) {
  const home = mkdtempSync(join(tmpdir(), 'jpc-test-'));
  mkdirSync(join(home, '.claude', 'jevpromptcoach'), { recursive: true });
  writeFileSync(join(home, '.claude', 'jevpromptcoach', '.env'), 'TYPESAFE_API_KEY=not-a-real-key\n');
  writeFileSync(
    join(home, '.claude', 'jevpromptcoach', 'config.json'),
    JSON.stringify({ mode: 'always', privacy, setupComplete: true, alwaysTimeoutMs: 8000, bypassPrefix: '*' }),
  );
  const child = spawn(process.execPath, ['dist/hook.js'], {
    env: { ...process.env, HOME: home, TYPESAFE_BASE_URL: `http://127.0.0.1:${port}` },
  });
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += c; });
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
      child.stdout.on('data', (c) => { stdout += c; });
      child.stdin.end(input);
      child.on('close', (status) => resolve({ status, stdout }));
    });
    assert.equal(r.status, 0, `exit ${r.status} on input ${JSON.stringify(input)}`);
    assert.equal(r.stdout, '', 'nothing should be printed');
  }
});
