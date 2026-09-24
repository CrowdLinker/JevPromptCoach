/**
 * Everything the slash commands run. All Jev calls live here — the hook never
 * makes one in on-demand mode.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CHECKS, GATES } from './checks.js';
import { apiKey, apiKeySource, ENV_PATH, LOG_PATH, loadConfig, saveConfig } from './config.js';
import { buildPairs, detectCorrections, estimateCorrectionTokens } from './correction.js';
import { promptHash } from './hash.js';
import { readHistory } from './history.js';
import { USD_PER_INPUT_TOKEN } from './jev.js';
import {
  appendLogMany,
  appendScores,
  clearLocalData,
  compactScores,
  hasText,
  type LogEntry,
  readCorrections,
  readLog,
  readScores,
  writeCorrections,
} from './log.js';
import { applyPrivacy } from './redact.js';
import { buildReport } from './report.js';
import { renderReport, renderScore } from './render.js';
import { estimateScoringTokens, interpret, scoreMany, scoreOne } from './score.js';
import { skipReason } from './skip.js';

const out = (s: string): void => {
  process.stdout.write(s + '\n');
};

function requireKey(): boolean {
  if (apiKey()) return true;
  out('No TypeSafe API key found.');
  out('');
  out("JevPromptCoach runs on TypeSafe's Jev model and makes no calls without it.");
  out('Get a key at https://console.typesafe.ai/settings/keys, then put it in the');
  out('key file — created locked down first, so the key is never world-readable');
  out('and never sits in your shell history:');
  out('');
  out('  mkdir -p ~/.claude/jevpromptcoach');
  out('  touch ~/.claude/jevpromptcoach/.env');
  out('  chmod 600 ~/.claude/jevpromptcoach/.env');
  out('');
  out('Then add one line to ~/.claude/jevpromptcoach/.env:');
  out('');
  out('  TYPESAFE_API_KEY=your-key-here');
  out('');
  out('Your logged prompts are untouched and nothing was sent.');
  return false;
}

/** Jev bills input tokens only; output is free. */
const usd = (tokens: number): string => `$${(tokens * USD_PER_INPUT_TOKEN).toFixed(4)}`;

// ---------------------------------------------------------------- score

async function cmdScore(argv: string[], stdinText?: string): Promise<void> {
  const text = (stdinText ?? argv.join(' ')).trim();

  if (!text) {
    out('/jevpromptcoach:score takes the prompt text you want checked, as an argument.');
    out('');
    out('It scores a draft before you send it, so you can fix it while it is still cheap.');
    out('');
    out('Example:');
    out('');
    out('  /jevpromptcoach:score Fix the token refresh in src/auth/session.ts so an expired');
    out('  refresh token returns 401 instead of throwing. Do not change the public');
    out('  signature of refreshSession. Verify with npm test -- session.spec.ts');
    out('');
    out('Seven checks run: ' + CHECKS.map((c) => c.id).join(', ') + '.');
    return;
  }

  const skip = skipReason(text, loadConfig().bypassPrefix);
  if (skip === 'too_short' || skip === 'acknowledgement') {
    out(`Too short to score (${skip.replace('_', ' ')}). Give it a real prompt to check.`);
    return;
  }

  if (!requireKey()) return;

  const config = loadConfig();
  const { text: safe } = applyPrivacy(text, config.privacy === 'metadata_only' ? 'redact' : config.privacy);
  const sendable = safe ?? text;
  const hash = promptHash(text);

  // A score that depended on session context is not this text judged alone.
  const cached = readScores().get(hash);
  if (cached && !cached.context) {
    out(renderScore(text, interpret(hash, cached.probabilities, cached.gates)));
    out('');
    out('(cached — this exact text was scored before)');
    return;
  }

  const scored = await scoreOne(sendable, hash, { timeoutMs: 30_000 });
  if (!scored) {
    out('Jev did not answer. Nothing was scored and nothing was changed.');
    return;
  }
  appendScores([scored.record]);
  out(renderScore(text, scored.result));
}

// ---------------------------------------------------------------- report

async function cmdReport(argv: string[]): Promise<void> {
  const requested = Math.max(1, Number.parseInt(argv[0] ?? '200', 10) || 200);
  const entries = readLog();

  if (entries.length === 0) {
    out(
      renderReport(
        {
          promptsConsidered: 0,
          promptsScored: 0,
          sessions: 0,
          from: null,
          to: null,
          meanScore: null,
          checks: [],
          trend: [],
          trendDelta: null,
          focus: null,
          correction: { available: false, judged: 0, overallRate: null, signalValidated: false },
        },
        requested,
      ),
    );
    return;
  }

  const window = entries.slice(-requested);
  const scores = readScores();

  const unscored = window.filter(hasText).filter((e) => !scores.has(e.hash));
  // Without a key we cannot score the new ones, but we can still report on
  // everything already scored. Refusing to print anything would make the report
  // permanently unusable, since the hook keeps logging new prompts.
  if (unscored.length > 0 && !apiKey()) {
    process.stderr.write(
      `TYPESAFE_API_KEY is not set, so ${unscored.length} newer prompts could not be scored.\n` +
        'Reporting on what is already scored. Nothing was sent.\n',
    );
  } else if (unscored.length > 0) {
    const tokens = estimateScoringTokens(unscored.map((e) => e.text));
    process.stderr.write(`Scoring ${unscored.length} new prompts (~${usd(tokens)})…\n`);
    const records = await scoreMany(
      unscored.map((e) => ({ hash: e.hash, text: e.text })),
      { onProgress: (d, t) => process.stderr.write(`  batch ${d}/${t}\r`) },
    );
    appendScores(records);
    for (const record of records) scores.set(record.hash, record);
    process.stderr.write('\n');
  }

  out(renderReport(buildReport({ entries: window, scores, corrections: readCorrections() }), requested));
}

// ---------------------------------------------------------------- backfill

async function cmdBackfill(argv: string[]): Promise<void> {
  const confirmed = argv.includes('--confirm');
  const limit = Number.parseInt(argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '0', 10) || 0;
  const config = loadConfig();

  process.stderr.write('Reading Claude Code history…\n');
  const history = await readHistory();
  const usable = history.filter((p) => skipReason(p.text, config.bypassPrefix) === null);
  const selected = limit > 0 ? usable.slice(-limit) : usable;

  if (selected.length === 0) {
    out('No prompts found in ~/.claude/projects that are worth scoring.');
    return;
  }

  const existing = new Set(readLog().map((e) => e.hash));
  const fresh = selected.filter((p) => !existing.has(promptHash(p.text)));

  const provisional: LogEntry[] = fresh.map((p) => {
    const { text, features } = applyPrivacy(p.text, config.privacy);
    return {
      ts: p.ts,
      session: p.session,
      hash: promptHash(p.text),
      text,
      features,
      source: 'backfill' as const,
      project: p.project,
    };
  });
  const sendable = provisional.filter(hasText).map((e) => ({ hash: e.hash, text: e.text }));
  const scoringTokens = estimateScoringTokens(sendable.map((e) => e.text));
  const pairs = buildPairs(provisional);
  const correctionTokens = estimateCorrectionTokens(pairs);

  if (!confirmed) {
    out('# Backfill estimate');
    out('');
    out(`Transcripts scanned:      ${history.length} human-typed prompts found`);
    out(`Worth scoring:            ${selected.length}`);
    out(`New (not already logged): ${fresh.length}`);
    out(`Correction-rate pairs:    ${pairs.length}`);
    out('');
    out(`Scoring:     ~${scoringTokens.toLocaleString()} input tokens  ~${usd(scoringTokens)}`);
    out(`Corrections: ~${correctionTokens.toLocaleString()} input tokens  ~${usd(correctionTokens)}`);
    out(`Total:       ~${usd(scoringTokens + correctionTokens)}  (Jev charges input tokens only; output is free)`);
    out('');
    out(`Privacy level in force: ${config.privacy}.`);
    out(
      config.privacy === 'redact'
        ? 'Paths, emails and credential-shaped strings are stripped before anything is sent.'
        : config.privacy === 'metadata_only'
          ? 'No prompt text will be sent. Derived features only — and scoring needs text, so this will score nothing.'
          : 'RAW: prompt text is sent as written, with credential-shaped strings still stripped.',
    );
    out('');
    out('Nothing has been sent. To go ahead, run the command again and confirm.');
    return;
  }

  if (!requireKey()) return;
  if (config.privacy === 'metadata_only') {
    out('Privacy is set to metadata_only, so no prompt text can be sent and nothing can be scored.');
    out('Switch to redact with /jevpromptcoach:config if you want a backfill.');
    return;
  }

  appendLogMany(provisional);

  process.stderr.write(`Scoring ${fresh.length} prompts…\n`);
  let usedTokens = 0;
  const records = await scoreMany(sendable, {
    onUsage: (u) => {
      usedTokens += u.input_tokens;
    },
    onProgress: (d, t) => process.stderr.write(`  scoring batch ${d}/${t}\r`),
  });
  appendScores(records);
  compactScores();
  process.stderr.write('\n');

  process.stderr.write(`Judging ${pairs.length} prompt pairs for corrections…\n`);
  const corrections = await detectCorrections(pairs, {
    onUsage: (u) => {
      usedTokens += u.input_tokens;
    },
    onProgress: (d, t) => process.stderr.write(`  correction batch ${d}/${t}\r`),
  });
  process.stderr.write('\n');

  const merged = readCorrections();
  for (const record of corrections) merged.set(record.hash, record);
  writeCorrections(merged.values());

  saveConfig({ ...config, lastBackfill: new Date().toISOString(), setupComplete: true });

  out('# Backfill complete');
  out('');
  out(`Prompts logged and scored: ${records.length}`);
  out(`Prompt pairs judged:       ${corrections.length}`);
  out(`Input tokens billed:       ${usedTokens.toLocaleString()}  (~${usd(usedTokens)})`);
  out('');
  out('Run /jevpromptcoach:report to see it.');
}

// ---------------------------------------------------------------- config

async function cmdConfig(argv: string[]): Promise<void> {
  const config = loadConfig();

  if (argv.length === 0 || argv[0] === 'show') {
    const entries = readLog();
    const scores = readScores();
    out('# JevPromptCoach configuration');
    out('');
    out(
      `Mode:            ${config.mode}${config.mode === 'on-demand' ? '  (hook only logs; zero added latency)' : '  (hook also scores and prints one line)'}`,
    );
    out(`Privacy:         ${config.privacy}`);
    out(`Bypass prefix:   ${config.bypassPrefix}  (a prompt starting with this is never logged or scored)`);
    out(`Always timeout:  ${config.alwaysTimeoutMs} ms`);
    out(`Last backfill:   ${config.lastBackfill ?? 'never'}`);
    // Name the source that actually answered. Saying TYPESAFE_API_KEY when the
    // key came from the file sends anyone debugging a missing key to the wrong
    // place, and the file is the method the docs now teach.
    const source = apiKeySource();
    out(
      `API key:         ${
        source === 'environment'
          ? 'set (TYPESAFE_API_KEY in the environment)'
          : source === 'key file'
            ? `set (${ENV_PATH})`
            : 'NOT SET — no scoring is possible'
      }`,
    );
    out('');
    out(`Log:             ${LOG_PATH}`);
    out(`Prompts logged:  ${entries.length}`);
    out(`Prompts scored:  ${scores.size}`);
    out('');
    out('Change it with:');
    out('  mode on-demand | mode always');
    out('  privacy redact | privacy metadata_only | privacy raw');
    out('  timeout <ms>');
    out('  clear            (delete the local log and score cache)');
    out('  backfill         (import and score your Claude Code history)');
    return;
  }

  const [key, value] = argv;

  if (key === 'mode') {
    if (value !== 'on-demand' && value !== 'always') {
      out('mode must be on-demand or always');
      return;
    }
    saveConfig({ ...config, mode: value, setupComplete: true });
    out(`Mode set to ${value}.`);
    if (value === 'always') {
      out('');
      out(`Every prompt over ${config.alwaysTimeoutMs} ms of scoring is abandoned silently.`);
      out(`Prefix a prompt with "${config.bypassPrefix}" to skip it entirely.`);
      out('Only findings that clear the confidence margin are shown.');
    }
    return;
  }

  if (key === 'privacy') {
    if (value !== 'redact' && value !== 'metadata_only' && value !== 'raw') {
      out('privacy must be redact, metadata_only or raw');
      return;
    }
    saveConfig({ ...config, privacy: value, setupComplete: true });
    out(`Privacy set to ${value}.`);
    if (value === 'raw') out('Prompt text will be sent as written. Credential-shaped strings are still stripped.');
    if (value === 'metadata_only') out('No prompt text will be logged or sent. Scoring needs text, so scoring is off.');
    return;
  }

  if (key === 'timeout') {
    const ms = Number.parseInt(value ?? '', 10);
    if (!Number.isFinite(ms) || ms < 500 || ms > 30_000) {
      out('timeout must be between 500 and 30000 ms');
      return;
    }
    saveConfig({ ...config, alwaysTimeoutMs: ms });
    out(`Always-mode timeout set to ${ms} ms.`);
    return;
  }

  if (key === 'clear') {
    clearLocalData();
    out('Local log, score cache and correction records deleted.');
    return;
  }

  if (key === 'backfill') {
    await cmdBackfill(argv.slice(1));
    return;
  }

  out(`Unknown setting: ${key}`);
}

// ---------------------------------------------------------------- fixtures

/**
 * Build an unlabelled eval fixture set from local history. Entirely local:
 * nothing is sent, and no API key is needed. The labels are left null because
 * they have to be set by hand, from the criteria, before the eval is run.
 */
async function cmdFixturesInit(argv: string[]): Promise<void> {
  const count = Number.parseInt(argv.find((a) => a.startsWith('--count='))?.split('=')[1] ?? '40', 10) || 40;
  const outPath = argv.find((a) => a.startsWith('--out='))?.split('=')[1] ?? 'test/fixtures/prompts.json';
  const config = loadConfig();

  process.stderr.write('Reading Claude Code history…\n');
  const history = await readHistory();
  const usable = history.filter((p) => skipReason(p.text, config.bypassPrefix) === null);
  const unique = [...new Map(usable.map((p) => [p.text, p])).values()];

  if (unique.length < count) {
    out(`Only ${unique.length} usable prompts in your history; need ${count}.`);
    return;
  }

  // Stratify by length so short, medium and long prompts are all represented.
  unique.sort((a, b) => a.text.length - b.text.length);
  const third = Math.floor(unique.length / 3);
  const buckets = [unique.slice(0, third), unique.slice(third, 2 * third), unique.slice(2 * third)];
  const perBucket = Math.ceil(count / 3);
  const picked: typeof unique = [];
  for (const bucket of buckets) {
    const step = Math.max(1, Math.floor(bucket.length / perBucket));
    for (let i = 0; i < bucket.length && picked.length < count; i += step) {
      const prompt = bucket[i];
      if (prompt) picked.push(prompt);
    }
  }

  const fixtures = picked.slice(0, count).map((p, i) => ({
    id: `p${String(i).padStart(2, '0')}`,
    text: p.text,
    labels: Object.fromEntries(CHECKS.map((c) => [c.id, null])),
    gates: Object.fromEntries(GATES.map((g) => [g.id, null])),
  }));

  writeFileSync(outPath, `${JSON.stringify(fixtures, null, 1)}\n`);
  out(`Wrote ${fixtures.length} unlabelled fixtures to ${outPath}.`);
  out('');
  out('Nothing was sent anywhere. Label them by hand from the criteria in');
  out('src/checks.ts before running `npm run eval` — see test/fixtures/README.md.');
  out('Do not commit this file.');
}

// ---------------------------------------------------------------- status

function cmdStatus(): void {
  const config = loadConfig();
  const entries = readLog();
  out(
    JSON.stringify({
      setupComplete: config.setupComplete,
      mode: config.mode,
      privacy: config.privacy,
      hasKey: Boolean(apiKey()),
      logged: entries.length,
      scored: readScores().size,
      lastBackfill: config.lastBackfill,
    }),
  );
}

// ---------------------------------------------------------------- main

const [command, ...rest] = process.argv.slice(2);

const run = async (): Promise<void> => {
  switch (command) {
    case 'score':
      return cmdScore(rest);
    case 'score-stdin': {
      // The prompt text arrives on stdin inside a quoted heredoc, so no shell
      // expansion ever touches what the developer typed.
      let text = '';
      try {
        text = readFileSync(0, 'utf8');
      } catch {
        /* no stdin */
      }
      return cmdScore([], text);
    }
    case 'report':
      return cmdReport(rest);
    case 'config':
      return cmdConfig(rest);
    case 'backfill':
      return cmdBackfill(rest);
    case 'fixtures-init':
      return cmdFixturesInit(rest);
    case 'status':
      return cmdStatus();
    default:
      out('usage: cli.js score <text> | report [n] | config [...] | backfill [--confirm] | fixtures-init | status');
  }
};

run().catch((err: unknown) => {
  // Never a stack trace, never a key.
  out(`JevPromptCoach could not complete that: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`);
  process.exit(0);
});
