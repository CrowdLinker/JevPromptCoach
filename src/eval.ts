/**
 * Eval harness. `npm run eval`.
 *
 * Runs the real scoring path over test/fixtures/prompts.json and compares
 * against hand labels.
 *
 * The headline metric is fail-precision: of the prompts where the plugin says
 * a habit is MISSING, how many really were. That is the number that matters,
 * because a missing-habit finding is the only thing `always` mode ever puts on
 * screen, and a false one interrupts a message for nothing. Pass-precision is
 * reported too, but it is not what gates the inline line.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CHECKS, type CheckId, GATES } from './checks.js';
import { apiKey } from './config.js';
import { MODEL, USD_PER_INPUT_TOKEN } from './jev.js';
import type { ScoreRecord } from './log.js';
import { scoreMany } from './score.js';

interface Fixture {
  id: string;
  text: string;
  labels: Record<CheckId, boolean | null>;
  gates: Record<string, boolean>;
}

interface ClassMetrics {
  precision: number | null;
  recall: number | null;
  support: number;
  predicted: number;
}

function metricsFor(rows: { truth: boolean; predicted: boolean }[], positive: boolean): ClassMetrics {
  const tp = rows.filter((r) => r.predicted === positive && r.truth === positive).length;
  const fp = rows.filter((r) => r.predicted === positive && r.truth !== positive).length;
  const fn = rows.filter((r) => r.predicted !== positive && r.truth === positive).length;
  const support = tp + fn;
  const predicted = tp + fp;
  return {
    precision: predicted > 0 ? tp / predicted : null,
    recall: support > 0 ? tp / support : null,
    support,
    predicted,
  };
}

const fmt = (v: number | null): string => (v === null ? '  -- ' : v.toFixed(2).padStart(5));

/** Minimum positives before a precision figure is worth quoting. */
const MIN_SUPPORT = 5;
const TARGET_PRECISION = 0.9;
/**
 * Thresholds are tuned against a stricter bar than they are reported against,
 * so a shipped threshold has headroom above 0.90 rather than sitting on it.
 */
const TUNING_PRECISION = 0.95;

async function main(): Promise<void> {
  if (!apiKey()) {
    process.stderr.write('TYPESAFE_API_KEY is not set. The eval calls Jev and cannot run without it.\n');
    process.exit(1);
  }

  const fixtures = JSON.parse(readFileSync('test/fixtures/prompts.json', 'utf8')) as Fixture[];

  let inputTokens = 0;
  let records: ScoreRecord[];
  const cachePath = 'test/eval-raw.json';
  if (process.argv.includes('--cached') && existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as { inputTokens: number; records: ScoreRecord[] };
    records = cached.records;
    inputTokens = cached.inputTokens;
    process.stderr.write(`Using cached probabilities from ${cachePath} (no API calls).\n`);
  } else {
    process.stderr.write(`Scoring ${fixtures.length} fixtures…\n`);
    records = await scoreMany(
      fixtures.map((f) => ({ hash: f.id, text: f.text })),
      {
        onUsage: (u) => {
          inputTokens += u.input_tokens;
        },
        onProgress: (d, t) => process.stderr.write(`  batch ${d}/${t}\n`),
      },
    );
    writeFileSync(cachePath, `${JSON.stringify({ inputTokens, records }, null, 1)}\n`);
  }
  const byId = new Map<string, ScoreRecord>(records.map((r) => [r.hash, r]));
  const missing = fixtures.filter((f) => !byId.has(f.id));
  if (missing.length > 0) {
    process.stderr.write(`WARNING: ${missing.length} fixtures got no answer and are excluded.\n`);
  }

  const tune = process.argv.includes('--tune');
  const lines: string[] = [];
  const results: Record<string, unknown> = {};
  let allClear = true;

  lines.push('Gates');
  lines.push('  gate                 acc   n');
  for (const gate of GATES) {
    let correct = 0;
    let total = 0;
    for (const fixture of fixtures) {
      const record = byId.get(fixture.id);
      const p = record?.gates[gate.id];
      if (p === undefined) continue;
      total += 1;
      if (p >= 0.5 === fixture.gates[gate.id]) correct += 1;
    }
    lines.push(`  ${gate.id.padEnd(20)} ${total ? (correct / total).toFixed(2) : ' -- '}  ${total}`);
  }
  lines.push('');

  lines.push('Checks — FAIL is the class that gates `always` mode');
  lines.push('');
  lines.push('  check                 thr | fail-P fail-R  n | pass-P pass-R  n | verdict');

  for (const def of CHECKS) {
    // Applicability follows the hand-labelled gate, so a check is judged on the
    // prompts it was meant for, exactly as the report judges it.
    const rows: { truth: boolean; predicted: boolean }[] = [];
    const raw: { truth: boolean; p: number }[] = [];
    for (const fixture of fixtures) {
      const truth = fixture.labels[def.id];
      if (truth === null || truth === undefined) continue;
      const record = byId.get(fixture.id);
      const p = record?.probabilities[def.id];
      if (p === undefined) continue;
      rows.push({ truth, predicted: p >= def.threshold });
      raw.push({ truth, p });
    }

    const fail = metricsFor(
      rows.map((r) => ({ truth: !r.truth, predicted: !r.predicted })),
      true,
    );
    const pass = metricsFor(rows, true);

    let best = def.threshold;
    if (tune) {
      let bestScore = -1;
      for (let t = 0.05; t <= 0.95; t += 0.05) {
        const tuned = metricsFor(
          raw.map((r) => ({ truth: !r.truth, predicted: r.p < t })),
          true,
        );
        if (tuned.precision === null || tuned.support < MIN_SUPPORT) continue;
        // Maximise recall subject to clearing the precision bar.
        const score =
          tuned.precision >= TUNING_PRECISION ? 1 + (tuned.recall ?? 0) + tuned.precision / 100 : tuned.precision;
        if (score > bestScore) {
          bestScore = score;
          best = Number(t.toFixed(2));
        }
      }
    }

    const measurable = fail.support >= MIN_SUPPORT && fail.precision !== null;
    const clears = measurable && fail.precision! >= TARGET_PRECISION;
    if (measurable && !clears) allClear = false;
    const verdict = !measurable
      ? `too few fail cases (n=${fail.support}) — not measurable`
      : clears
        ? 'ok'
        : `BELOW ${TARGET_PRECISION}`;

    lines.push(
      `  ${def.id.padEnd(20)} ${def.threshold.toFixed(2)} |  ${fmt(fail.precision)}  ${fmt(fail.recall)} ${String(fail.support).padStart(2)} |  ${fmt(pass.precision)}  ${fmt(pass.recall)} ${String(pass.support).padStart(2)} | ${verdict}${tune ? `  (best thr ${best})` : ''}`,
    );

    results[def.id] = {
      threshold: def.threshold,
      fail: { precision: fail.precision, recall: fail.recall, support: fail.support },
      pass: { precision: pass.precision, recall: pass.recall, support: pass.support },
      measurable,
      clearsTarget: clears,
      ...(tune ? { suggestedThreshold: best } : {}),
    };
  }

  // Thresholds were chosen on these same 40 prompts, so the figures above are
  // optimistic. This repeats the whole selection inside five folds and scores
  // only held-out prompts, which is the number worth quoting. It needs no extra
  // API calls because the probabilities are already in hand.
  lines.push('');
  lines.push('Five-fold cross-validated fail-precision (thresholds re-selected per fold)');
  lines.push('');
  lines.push('  check                 fail-P fail-R  n');
  const cvResults: Record<string, unknown> = {};
  for (const def of CHECKS) {
    const labelled = fixtures
      .map((f) => ({ truth: f.labels[def.id], p: byId.get(f.id)?.probabilities[def.id] }))
      .filter((r): r is { truth: boolean; p: number } => typeof r.truth === 'boolean' && r.p !== undefined);

    const held: { truth: boolean; predicted: boolean }[] = [];
    for (let fold = 0; fold < 5; fold += 1) {
      const test = labelled.filter((_, i) => i % 5 === fold);
      const train = labelled.filter((_, i) => i % 5 !== fold);
      let thr = def.threshold;
      let bestScore = -1;
      for (let t = 0.05; t <= 0.95; t += 0.05) {
        const m = metricsFor(
          train.map((r) => ({ truth: !r.truth, predicted: r.p < t })),
          true,
        );
        if (m.precision === null) continue;
        const score = m.precision >= TUNING_PRECISION ? 1 + (m.recall ?? 0) : m.precision;
        if (score > bestScore) {
          bestScore = score;
          thr = Number(t.toFixed(2));
        }
      }
      for (const r of test) held.push({ truth: !r.truth, predicted: r.p < thr });
    }
    const cv = metricsFor(held, true);
    cvResults[def.id] = { precision: cv.precision, recall: cv.recall, support: cv.support };
    lines.push(`  ${def.id.padEnd(20)}  ${fmt(cv.precision)}  ${fmt(cv.recall)} ${String(cv.support).padStart(2)}`);
  }
  results['_crossValidated'] = cvResults;

  lines.push('');
  lines.push(`Input tokens: ${inputTokens.toLocaleString()}  (~$${(inputTokens * USD_PER_INPUT_TOKEN).toFixed(4)})`);
  lines.push(
    allClear
      ? `All measurable checks clear fail-precision ${TARGET_PRECISION}.`
      : `At least one measurable check is below fail-precision ${TARGET_PRECISION}.`,
  );

  const report = lines.join('\n');
  process.stdout.write(report + '\n');

  writeFileSync(
    'test/eval-results.json',
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        model: MODEL,
        fixtures: fixtures.length,
        inputTokens,
        targetPrecision: TARGET_PRECISION,
        checks: results,
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync('test/eval-results.txt', report + '\n');
  process.exit(allClear ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`eval failed: ${err instanceof Error ? err.message : 'unknown'}\n`);
  process.exit(1);
});
