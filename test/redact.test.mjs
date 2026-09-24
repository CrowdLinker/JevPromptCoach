/**
 * The privacy guarantee. This is the one behaviour where being wrong leaks a
 * credential to a third party, so it is tested directly rather than by eye.
 * Uses node:test — no test framework dependency.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, stripCredentials, features } from '../dist/redact.js';

/**
 * Every value below is invented, and each is assembled from fragments at
 * runtime so that no file in this repository ever contains a contiguous string
 * shaped like a credential. GitHub's push protection flags those on sight —
 * correctly, since it cannot know an invented key from a live one — and a repo
 * about not leaking secrets is the last place to start clicking "allow".
 *
 * The joined values are byte-for-byte what the redactor sees, so the test is
 * unchanged by this; only the file on disk is.
 */
const j = (...parts) => parts.join('');

const SECRETS = [
  ['anthropic', j('key is ', 'sk-', 'ant-', 'api03-', 'AAAABBBBCCCCDDDDEEEEFFFF1234'), 'AAAABBBBCCCCDDDDEEEEFFFF1234'],
  ['openai', j('OPENAI key ', 'sk-', 'proj-', 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'), 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
  ['github', j('token ', 'ghp', '_', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'), 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
  ['aws', j('id ', 'AKIA', 'IOSFODNN7EXAMPLE', ' here'), j('AKIA', 'IOSFODNN7EXAMPLE')],
  ['google', j('AIza', 'SyA1234567890abcdefghijklmnopqrstuvw', ' maps key'), 'SyA1234567890abcdefghijklmnopqrstuvw'],
  ['slack', j('xox', 'b-', '123456789012-', 'abcdefghijklmnop'), 'abcdefghijklmnop'],
  [
    'pem',
    j('-----', 'BEGIN RSA ', 'PRIVATE KEY', '-----\nMIIEowIBAAKCAQEA\n-----', 'END RSA ', 'PRIVATE KEY', '-----'),
    'MIIEowIBAAKCAQEA',
  ],
  ['assigned', j('DATABASE_PASSWORD', '=', 'hunter2correcthorse'), 'hunter2correcthorse'],
  ['bearer', j('Authorization: ', 'Bearer ', 'abcdef1234567890xyz'), 'abcdef1234567890xyz'],
  [
    'jwt',
    j('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r'),
    'dBjftJeZ4CVPmB92K27uhbUJU1p1r',
  ],
  // Shapes an agent's reply quotes back from .env files, config and command output.
  ['stripe', j('key ', 'sk_', 'live_', '51HxYzAbCdEfGhIjKlMnOp'), '51HxYzAbCdEfGhIjKlMnOp'],
  ['stripe-restricted', j('rk_', 'test_', '51HxYzAbCdEfGhIjKlMnOp'), '51HxYzAbCdEfGhIjKlMnOp'],
  ['npm', j('npm', '_', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'), 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
  [
    'github-fine-grained',
    j('github_', 'pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'),
    '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
  ],
  [
    'sendgrid',
    j('SG', '.', 'abcdefghijklmnopqrstuv', '.', 'abcdefghijklmnopqrstuvwxyz0123'),
    'abcdefghijklmnopqrstuvwxyz0123',
  ],
  ['slack-webhook', j('https://hooks.', 'slack.com/services/', 'T0000/B0000/', 'XXXXXXXXXXXXXXXX'), 'XXXXXXXXXXXXXXXX'],
  ['url-credentials', j('connect with mysql://root:', 's3cretPw9', '@10.0.0.4/app'), 's3cretPw9'],
  ['url-credentials-in-env', j('DATABASE_URL=postgres://app:', 'Hunter2pass', '@db.internal:5432/prod'), 'Hunter2pass'],
  [
    'azure-sas',
    j('https://acct.blob.core.windows.net/c/f?sv=2022&', 'sig=', 'AbCdEfGhIjKlMnOp%2BqRsT%3D'),
    'AbCdEfGhIjKlMnOp',
  ],
  ['underscored-pass', j('DB_', 'PASS', '=', 'abcDEF123456'), 'abcDEF123456'],
  ['json-password', j('{"pass', 'word": "', 'CorrectHorse99', '"}'), 'CorrectHorse99'],
];

test('every credential shape is removed by redact()', () => {
  for (const [name, input, secret] of SECRETS) {
    const out = redact(input);
    assert.ok(!out.includes(secret), `${name}: secret survived redact(): ${out}`);
  }
});

test('credentials are stripped even at privacy level raw', () => {
  for (const [name, input, secret] of SECRETS) {
    const out = stripCredentials(input);
    assert.ok(!out.includes(secret), `${name}: secret survived stripCredentials(): ${out}`);
  }
});

test('emails go, filenames stay', () => {
  const out = redact('ask alice@example.com about src/auth/session.ts');
  assert.ok(!out.includes('alice@example.com'), out);
  assert.ok(out.includes('session.ts'), `filename must survive for named_target: ${out}`);
});

test('home directories are reduced to a basename', () => {
  const out = redact('open /Users/prateek/work/secret-client/app/main.ts now');
  assert.ok(!out.includes('prateek'), out);
  assert.ok(!out.includes('secret-client'), out);
  assert.ok(out.includes('main.ts'), `filename must survive: ${out}`);
});

test('metadata_only features cannot reconstruct the text', () => {
  const f = features('Fix the bug in src/a.ts\n```js\nx\n```');
  assert.equal(typeof f.chars, 'number');
  assert.ok(f.hasCodeFence && f.hasFilePath);
  assert.ok(!JSON.stringify(f).includes('src/a.ts'));
});

test('an unlabelled Azure client secret is removed', () => {
  // A synthetic secret in the shape of a real one: an Azure client secret was
  // found pasted in local Claude Code history as "value - <secret>", with no
  // KEY= to anchor on, which is why this rule exists. The real value is not
  // reproduced here.
  const input = j('my-app-bff\nvalue - ', '9aB2Q~', 'XyZwVuTsRq-pO.nMlKjIh', '~GfEdCbA1234', '\nSecret ID - 03795f14');
  for (const out of [redact(input), stripCredentials(input)]) {
    assert.ok(!out.includes('9aB2Q~XyZwVuTsRq'), `secret survived: ${out}`);
    assert.ok(!out.includes('GfEdCbA1234'), `secret survived: ${out}`);
  }
});

test('ordinary prose and code are left alone', () => {
  const samples = [
    'Refactor getUserById in src/users/service.ts and keep the signature',
    'Run npm test -- auth.spec.ts to check it',
    'The commit is 4f3a9c2e1b8d7a6f5e4d3c2b1a0987654321fedc',
    'See https://github.com/CrowdLinker/JevPromptCoach for details',
    // Code and prose that share words with the credential rules.
    'const bypass = userSettings.bypassPrefix',
    'oauth: googleOauthClient, author: someoneElse',
    'Run pwd to see the directory, then reset the password field on the form',
    'The value: 3 and the token count are both logged',
    'Open https://example.com/login?next=/dashboard&sig=short',
  ];
  for (const s of samples) {
    const out = redact(s);
    assert.ok(!out.includes('[KEY]'), `false positive on: ${s} -> ${out}`);
    assert.ok(!out.includes('[REDACTED]'), `false positive on: ${s} -> ${out}`);
  }
});
