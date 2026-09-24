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
import { createHash } from 'node:crypto';
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
function runHook(
  privacy,
  prompt = PROMPT,
  { log = [], scores = [], env = {}, transcript = null, transcriptIsDirectory = false } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'jpc-test-'));
  mkdirSync(join(home, '.claude', 'jevpromptcoach'), { recursive: true });
  if (log.length) {
    writeFileSync(
      join(home, '.claude', 'jevpromptcoach', 'prompts.jsonl'),
      log.map((e) => JSON.stringify({ features: {}, source: 'hook', ...e })).join('\n') + '\n',
    );
  }
  let transcriptPath;
  if (transcriptIsDirectory) {
    transcriptPath = join(home, 'transcript-dir');
    mkdirSync(transcriptPath);
  } else if (transcript) {
    transcriptPath = join(home, 'transcript.jsonl');
    writeFileSync(transcriptPath, transcript.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  if (scores.length) {
    writeFileSync(
      join(home, '.claude', 'jevpromptcoach', 'scores.jsonl'),
      scores.map((r) => JSON.stringify(r)).join('\n') + '\n',
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
      JEVPROMPTCOACH_SESSION_REPLIES: '',
      ...env,
      HOME: home,
      TYPESAFE_BASE_URL: `http://127.0.0.1:${port}`,
    },
  });
  let stdout = '';
  child.stdout.on('data', (c) => {
    stdout += c;
  });
  child.stdin.end(
    JSON.stringify({
      session_id: 's',
      cwd: '/tmp/d',
      hook_event_name: 'UserPromptSubmit',
      prompt,
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    }),
  );
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

/** The cache key the hook computes, mirrored from src/hash.ts. */
const hashOf = (text) => createHash('sha256').update(text.trim(), 'utf8').digest('hex').slice(0, 16);
const FOLLOW_UP = 'Now commit and push all of it';
const savedScore = (extra = {}) => ({
  hash: hashOf(FOLLOW_UP),
  ts: '2026-01-01T00:00:00.000Z',
  probabilities: { named_target: 0.99 },
  gates: {},
  model: 'test',
  ...extra,
});

/**
 * With replies turned off, a follow-up carries the two prompts before it in the
 * same session. They are
 * written to the log as raw text, as if captured under `raw`, so the test also
 * proves they are redacted again on the way out under `redact`.
 */
const EARLIER = [
  { ts: '2026-01-01T00:00:00.000Z', session: 's', hash: 'h0', text: 'oldest prompt, beyond the window' },
  { ts: '2026-01-01T00:01:00.000Z', session: 'other', hash: 'hx', text: 'a prompt from another session' },
  { ts: '2026-01-01T00:02:00.000Z', session: 's', hash: 'h1', text: `Mail bob@acme.com about ${SECRET}` },
  { ts: '2026-01-01T00:03:00.000Z', session: 's', hash: 'h2', text: 'Open /Users/someone/clients/acme/app/main.ts' },
];

test('without a transcript, a follow-up sends the two earlier prompts, redacted, and scores only the last', async () => {
  captured.length = 0;
  const result = await runHook('redact', FOLLOW_UP, { log: EARLIER });
  assert.equal(result.status, 0);
  assert.equal(captured.length, 1);

  const { state, questions } = captured[0];
  const texts = state.messages.map((m) => m.text);
  assert.equal(texts.length, 3, 'two context prompts plus the one being scored');
  assert.equal(state.messages.at(-1).id, 'm0');
  assert.equal(texts.at(-1), FOLLOW_UP);
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
  await runHook('redact', FOLLOW_UP, { log });
  assert.equal(captured[0].state.messages.length, 1);
});

test('JEVPROMPTCOACH_SESSION_CONTEXT=0 turns the context off', async () => {
  captured.length = 0;
  await runHook('redact', FOLLOW_UP, {
    log: EARLIER,
    env: { JEVPROMPTCOACH_SESSION_CONTEXT: '0' },
  });
  assert.equal(captured[0].state.messages.length, 1);
});

test('a first prompt is not served a score that depended on context', async () => {
  captured.length = 0;
  await runHook('redact', FOLLOW_UP, { scores: [savedScore({ context: 2 })] });
  assert.equal(captured.length, 1, 'expected a fresh request, not the context-based saved score');
});

test('a first prompt is served a saved standalone score', async () => {
  captured.length = 0;
  await runHook('redact', FOLLOW_UP, { scores: [savedScore()] });
  assert.equal(captured.length, 0, 'unchanged text scored alone should come from the cache');
});

test('a later score with context does not displace a saved standalone score', async () => {
  captured.length = 0;
  const later = savedScore({ ts: '2026-01-02T00:00:00.000Z', context: 2 });
  await runHook('redact', FOLLOW_UP, { scores: [savedScore(), later] });
  assert.equal(captured.length, 0, 'the standalone score should still be served from the cache');
});

test('a follow-up is scored fresh even when the same text was saved alone', async () => {
  captured.length = 0;
  await runHook('redact', FOLLOW_UP, { log: EARLIER, scores: [savedScore()] });
  assert.equal(captured.length, 1, 'expected a fresh request with context');
  assert.equal(captured[0].state.messages.length, 3);
});

test('/jevpromptcoach:score ignores a saved score that depended on context', async () => {
  captured.length = 0;
  const home = mkdtempSync(join(tmpdir(), 'jpc-test-'));
  const dir = join(home, '.claude', 'jevpromptcoach');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.env'), 'TYPESAFE_API_KEY=not-a-real-key\n');
  writeFileSync(join(dir, 'scores.jsonl'), JSON.stringify(savedScore({ context: 2 })) + '\n');
  const child = spawn(process.execPath, ['dist/cli.js', 'score', FOLLOW_UP], {
    env: { ...process.env, HOME: home, TYPESAFE_BASE_URL: `http://127.0.0.1:${port}` },
  });
  let stdout = '';
  child.stdout.on('data', (c) => {
    stdout += c;
  });
  await new Promise((resolve) => child.on('close', resolve));
  rmSync(home, { recursive: true, force: true });
  assert.equal(captured.length, 1, 'expected a fresh request, not the context-based saved score');
  assert.ok(!stdout.includes('(cached'), stdout);
});

/**
 * An invented Claude Code transcript, in the record shapes the plugin reads.
 * It holds everything that must never reach the wire from a transcript:
 * narration before a tool call, tool output, a subagent's text, and a bypassed
 * exchange whose reply repeats what the bypassed prompt held.
 */
const say = (role, content, extra = {}) => ({
  type: role,
  message: { role, content },
  sessionId: 's',
  timestamp: '2026-01-01T00:00:00.000Z',
  ...(role === 'user' ? { promptSource: 'typed' } : {}),
  ...extra,
});
const text = (t) => [{ type: 'text', text: t }];
const TRANSCRIPT = [
  say('user', 'oldest exchange, outside the window'),
  say('assistant', text('reply to the oldest exchange')),
  say('user', `Refactor the retry logic in src/queue/worker.ts and mail bob@acme.com`),
  say('assistant', text('narration before the tool call')),
  say('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
  say('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'TOOL OUTPUT BODY' }], { promptSource: undefined }),
  say('assistant', text('subagent chatter'), { isSidechain: true }),
  say('assistant', text(`Done, worker.ts backs off now. Deploy key was ${SECRET}. Want me to commit?`)),
  say('user', '*a bypassed prompt about the private client'),
  say('assistant', text('reply that repeats the private client')),
  say('user', 'Yes, and keep the exported constant as it is'),
  say('assistant', text('Kept it. Anything else before I commit?')),
];
const REPLIES_ON = { JEVPROMPTCOACH_SESSION_REPLIES: '1' };

test('with replies on, a follow-up sends the last two exchanges, redacted, and scores only the last', async () => {
  captured.length = 0;
  await runHook('redact', FOLLOW_UP, { transcript: TRANSCRIPT, env: REPLIES_ON });
  assert.equal(captured.length, 1);
  const { state, questions } = captured[0];

  assert.deepEqual(
    state.messages.map((m) => m.role),
    ['developer', 'agent', 'developer', 'agent', 'developer'],
    'two exchanges, then the prompt being scored',
  );
  assert.equal(state.messages.at(-1).id, 'm0');
  assert.equal(state.messages.at(-1).text, FOLLOW_UP);
  assert.match(state.messages[1].text, /Want me to commit\?$/);

  const sent = JSON.stringify(captured[0]);
  for (const never of [
    'oldest exchange',
    'narration before the tool call',
    'TOOL OUTPUT BODY',
    'subagent chatter',
    'bypassed prompt',
    'private client',
  ]) {
    assert.ok(!sent.includes(never), `"${never}" reached the wire`);
  }
  assert.ok(!sent.includes(SECRET), 'a reply leaked the API key');
  assert.ok(!sent.includes('bob@acme.com'), 'a prompt in the transcript leaked the email');

  assert.ok(
    Object.keys(questions).every((k) => k.startsWith('m0__')),
    'context must not be scored',
  );
  assert.match(questions.m0__named_target.instructions, /conversation/);
});

test('with replies on, the prompt being scored is not repeated when the transcript already has it', async () => {
  captured.length = 0;
  const transcript = [...TRANSCRIPT, say('user', FOLLOW_UP)];
  await runHook('redact', FOLLOW_UP, { transcript, env: REPLIES_ON });
  const texts = captured[0].state.messages.map((m) => m.text);
  assert.equal(texts.filter((t) => t === FOLLOW_UP).length, 1);
  assert.equal(texts.length, 5);
});

test('with replies on, only conversation checks the eval cleared reach the inline line', async () => {
  answerFor = () => 0.01;
  const { systemMessage } = JSON.parse(
    (await runHook('redact', FOLLOW_UP, { transcript: TRANSCRIPT, env: REPLIES_ON })).stdout,
  );
  const missing = systemMessage.split('\n')[1];
  assert.match(missing, /what must not change/);
  assert.match(missing, /the verification steps/);
  // Every check failed on the wire; these did not clear the conversation eval.
  for (const never of ['which file or function', 'what "done" looks like', 'a single focused requirement']) {
    assert.ok(!missing.includes(never), `${never} is not inline-eligible in conversation`);
  }
});

test('with a transcript, the first prompt of a session is still scored alone', async () => {
  captured.length = 0;
  await runHook('redact', FOLLOW_UP, { transcript: [say('user', FOLLOW_UP)] });
  assert.equal(captured[0].state.messages.length, 1);
  assert.equal(captured[0].state.messages[0].role, undefined, 'judged by the standalone criteria');
});

test('narration in the same record as a tool call is not sent', async () => {
  captured.length = 0;
  const transcript = [
    say('user', 'Refactor src/queue/worker.ts to back off exponentially'),
    say('assistant', [
      { type: 'text', text: 'narration sharing a record with the call' },
      { type: 'tool_use', id: 't9', name: 'Read', input: {} },
    ]),
    say('assistant', text('final answer about worker.ts')),
  ];
  await runHook('redact', FOLLOW_UP, { transcript });
  const sent = JSON.stringify(captured[0]);
  assert.ok(!sent.includes('narration sharing a record'), 'narration before the call reached the wire');
  assert.ok(sent.includes('final answer about worker.ts'));
});

test('a queued prompt is its own exchange', async () => {
  captured.length = 0;
  const transcript = [
    say('user', 'Refactor src/queue/worker.ts to back off exponentially'),
    say('assistant', text('first reply')),
    say('user', 'Also cap the delay at thirty seconds', { promptSource: 'queued' }),
    say('assistant', text('capped at 30s')),
  ];
  await runHook('redact', FOLLOW_UP, { transcript });
  assert.deepEqual(
    captured[0].state.messages.map((m) => m.text),
    [
      'Refactor src/queue/worker.ts to back off exponentially',
      'first reply',
      'Also cap the delay at thirty seconds',
      'capped at 30s',
      FOLLOW_UP,
    ],
  );
});

test('a bypassed queued prompt is dropped with its reply, and so is anything queued behind it', async () => {
  captured.length = 0;
  const transcript = [
    say('user', 'Refactor src/queue/worker.ts to back off exponentially'),
    say('assistant', text('first reply')),
    say('user', '*queued note about the private client', { promptSource: 'queued' }),
    say('assistant', text('reply that repeats the private client')),
    // Queued means the agent is still on the bypassed item; what follows answers it.
    say('user', 'Also cap the delay at thirty seconds', { promptSource: 'queued' }),
    say('assistant', text('capped, and the private client is set')),
  ];
  await runHook('redact', FOLLOW_UP, { transcript });
  const { state } = captured[0];
  assert.ok(!JSON.stringify(state).includes('private client'), 'a bypassed turn reached the wire');
  assert.deepEqual(
    state.messages.map((m) => m.text),
    ['Refactor src/queue/worker.ts to back off exponentially', 'first reply', FOLLOW_UP],
  );
});

test("a prompt queued during a bypassed turn does not carry that turn's reply", async () => {
  captured.length = 0;
  const transcript = [
    say('user', '*SECRETPROMPT deploy with the private key'),
    say('assistant', [{ type: 'tool_use', id: 'a1', name: 'Bash', input: {} }]),
    say('user', 'also run the tests after', { promptSource: 'queued' }),
    say('user', [{ type: 'tool_result', tool_use_id: 'a1', content: 'ok' }], { promptSource: undefined }),
    say('assistant', text('Done, used SECRETPROMPT')),
  ];
  await runHook('redact', FOLLOW_UP, { transcript });
  assert.ok(!JSON.stringify(captured[0]).includes('SECRETPROMPT'), 'the bypassed turn reached the wire');
});

test('narration before any kind of tool call is not sent', async () => {
  captured.length = 0;
  const transcript = [
    say('user', 'Search the docs for the retry API in src/queue/worker.ts'),
    say('assistant', [
      { type: 'text', text: 'narration before the search' },
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} },
    ]),
    say('assistant', text('final answer')),
  ];
  await runHook('redact', FOLLOW_UP, { transcript });
  const sent = JSON.stringify(captured[0]);
  assert.ok(!sent.includes('narration before the search'));
  assert.ok(sent.includes('final answer'));
});

test('an unreadable transcript falls back to the earlier prompts in the log', async () => {
  captured.length = 0;
  // A directory where the transcript should be: reading it throws.
  await runHook('redact', FOLLOW_UP, { log: EARLIER, transcript: [], transcriptIsDirectory: true });
  const { state } = captured[0];
  assert.equal(state.messages.length, 3, 'two earlier prompts from the log, then the one being scored');
  assert.ok(state.messages.every((m) => m.role === undefined));
});

test('text after a system or SDK message is not taken as a reply to the prompt before it', async () => {
  captured.length = 0;
  const transcript = [
    say('user', 'Refactor src/queue/worker.ts to back off exponentially'),
    say('assistant', text('the real reply')),
    say('user', 'a notice nobody typed', { promptSource: 'system' }),
    say('assistant', text('text answering the notice')),
    say('user', 'input from an SDK caller', { promptSource: 'sdk' }),
    say('assistant', text('text answering the SDK caller')),
  ];
  await runHook('redact', FOLLOW_UP, { transcript });
  const sent = JSON.stringify(captured[0]);
  assert.ok(sent.includes('the real reply'));
  for (const never of ['notice nobody typed', 'answering the notice', 'SDK caller']) {
    assert.ok(!sent.includes(never), `"${never}" reached the wire`);
  }
});

test('the prompt being scored is recognised even when the transcript splits it into blocks', async () => {
  captured.length = 0;
  const prompt = 'Commit the retry change\n\nthen push it to the branch';
  const transcript = [
    ...TRANSCRIPT,
    say('user', [
      { type: 'text', text: 'Commit the retry change' },
      { type: 'text', text: 'then push it to the branch' },
    ]),
  ];
  await runHook('redact', prompt, { transcript });
  const texts = captured[0].state.messages.map((m) => m.text);
  assert.equal(texts.length, 5, 'two exchanges, then the prompt, with no duplicate');
  assert.equal(texts.filter((t) => t.startsWith('Commit the retry change')).length, 1);
});

test('an earlier identical prompt that got a reply stays as context', async () => {
  captured.length = 0;
  const transcript = [say('user', FOLLOW_UP), say('assistant', text('pushed to the branch'))];
  await runHook('redact', FOLLOW_UP, { transcript });
  assert.deepEqual(
    captured[0].state.messages.map((m) => m.text),
    [FOLLOW_UP, 'pushed to the branch', FOLLOW_UP],
  );
});

test('replies are on by default', async () => {
  captured.length = 0;
  await runHook('redact', FOLLOW_UP, { transcript: TRANSCRIPT });
  assert.deepEqual(
    captured[0].state.messages.map((m) => m.role),
    ['developer', 'agent', 'developer', 'agent', 'developer'],
  );
});

test('JEVPROMPTCOACH_SESSION_REPLIES=0 leaves the replies out and sends earlier prompts only', async () => {
  captured.length = 0;
  await runHook('redact', FOLLOW_UP, {
    transcript: TRANSCRIPT,
    log: EARLIER,
    env: { JEVPROMPTCOACH_SESSION_REPLIES: '0' },
  });
  const { state } = captured[0];
  assert.ok(
    state.messages.every((m) => m.role === undefined),
    'no agent reply when turned off',
  );
  assert.ok(!JSON.stringify(state).includes('Want me to commit'));
  assert.equal(state.messages.length, 3, 'two earlier prompts from the log, then the one being scored');
});

test('with replies on, metadata_only still sends nothing', async () => {
  captured.length = 0;
  await runHook('metadata_only', FOLLOW_UP, { transcript: TRANSCRIPT, env: REPLIES_ON });
  assert.equal(captured.length, 0);
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
