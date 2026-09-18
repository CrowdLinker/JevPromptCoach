/**
 * Aggregation for /jevpromptcoach:report.
 *
 * Two numbers per check: how often the developer gets it right, and whether
 * getting it right is associated with fewer corrections. The second one is only
 * reported where the difference clears a significance test — an outcome signal
 * that is really noise is worse than no outcome signal.
 */
import { CHECKS, type CheckId } from './checks.js';
import type { CorrectionRecord, LogEntry, ScoreRecord } from './log.js';
import { interpret, type Verdict } from './score.js';

export interface CheckStat {
  id: CheckId;
  label: string;
  applicable: number;
  passed: number;
  /** Share of applicable prompts where the check passed. */
  hitRate: number;
  /** Correction rate among prompts where the check passed / failed. */
  correctionWhenPass: number | null;
  correctionWhenFail: number | null;
  passSample: number;
  failSample: number;
  /** correctionWhenFail - correctionWhenPass. Positive means the habit helps. */
  gap: number | null;
  /** Two-proportion z-test p-value for that gap. */
  pValue: number | null;
  significant: boolean;
}

export interface TrendPoint {
  day: string;
  score: number;
  count: number;
}

export interface Report {
  promptsConsidered: number;
  promptsScored: number;
  sessions: number;
  from: string | null;
  to: string | null;
  meanScore: number | null;
  checks: CheckStat[];
  trend: TrendPoint[];
  trendDelta: number | null;
  focus: CheckStat | null;
  correction: {
    available: boolean;
    judged: number;
    overallRate: number | null;
    /** True when at least one check shows a significant gap. */
    signalValidated: boolean;
  };
}

/** Normal CDF via Abramowitz & Stegun 7.1.26; good to ~1e-7, enough for a p-value. */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/** Two-tailed two-proportion z-test. */
function twoProportionP(a: number, na: number, b: number, nb: number): number | null {
  if (na < 1 || nb < 1) return null;
  const pooled = (a + b) / (na + nb);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / na + 1 / nb));
  if (!Number.isFinite(se) || se === 0) return null;
  const z = (a / na - b / nb) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

const MIN_SAMPLE_PER_ARM = 20;
const SIGNIFICANCE = 0.05;

export interface BuildReportInput {
  entries: LogEntry[];
  scores: Map<string, ScoreRecord>;
  corrections: Map<string, CorrectionRecord>;
  /** Trend window in days. */
  trendDays?: number;
}

export function buildReport(input: BuildReportInput): Report {
  const { entries, scores, corrections } = input;
  const trendDays = input.trendDays ?? 30;

  const verdicts = new Map<string, Map<CheckId, Verdict>>();
  const perPromptScore = new Map<string, number | null>();

  for (const entry of entries) {
    const record = scores.get(entry.hash);
    if (!record) continue;
    const result = interpret(entry.hash, record.probabilities, record.gates);
    const map = new Map<CheckId, Verdict>();
    for (const check of result.checks) map.set(check.id, check.verdict);
    verdicts.set(entry.hash, map);
    perPromptScore.set(entry.hash, result.score);
  }

  const scored = entries.filter((e) => verdicts.has(e.hash));

  const checkStats: CheckStat[] = CHECKS.map((def) => {
    let applicable = 0;
    let passed = 0;
    let passCorrected = 0;
    let passSample = 0;
    let failCorrected = 0;
    let failSample = 0;

    for (const entry of scored) {
      const verdict = verdicts.get(entry.hash)?.get(def.id);
      if (verdict !== 'pass' && verdict !== 'fail') continue;
      applicable += 1;
      if (verdict === 'pass') passed += 1;

      const correction = corrections.get(entry.hash);
      if (!correction) continue;
      if (verdict === 'pass') {
        passSample += 1;
        if (correction.corrected) passCorrected += 1;
      } else {
        failSample += 1;
        if (correction.corrected) failCorrected += 1;
      }
    }

    const correctionWhenPass = passSample >= 1 ? passCorrected / passSample : null;
    const correctionWhenFail = failSample >= 1 ? failCorrected / failSample : null;
    const gap =
      correctionWhenPass !== null && correctionWhenFail !== null ? correctionWhenFail - correctionWhenPass : null;
    const pValue =
      passSample >= MIN_SAMPLE_PER_ARM && failSample >= MIN_SAMPLE_PER_ARM
        ? twoProportionP(failCorrected, failSample, passCorrected, passSample)
        : null;

    return {
      id: def.id,
      label: def.label,
      applicable,
      passed,
      hitRate: applicable ? passed / applicable : 0,
      correctionWhenPass,
      correctionWhenFail,
      passSample,
      failSample,
      gap,
      pValue,
      significant: pValue !== null && pValue < SIGNIFICANCE && (gap ?? 0) > 0,
    };
  });

  // Trend: mean score per day over the window.
  const cutoff = Date.now() - trendDays * 24 * 60 * 60 * 1000;
  const byDay = new Map<string, { sum: number; n: number }>();
  for (const entry of scored) {
    const t = Date.parse(entry.ts);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const score = perPromptScore.get(entry.hash);
    if (score === null || score === undefined) continue;
    const day = entry.ts.slice(0, 10);
    const bucket = byDay.get(day) ?? { sum: 0, n: 0 };
    bucket.sum += score;
    bucket.n += 1;
    byDay.set(day, bucket);
  }
  const trend: TrendPoint[] = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, b]) => ({ day, score: Math.round(b.sum / b.n), count: b.n }));

  // First third versus last third of the window, so one loud day cannot move it.
  let trendDelta: number | null = null;
  if (trend.length >= 4) {
    const third = Math.max(1, Math.floor(trend.length / 3));
    const head = trend.slice(0, third);
    const tail = trend.slice(-third);
    const mean = (points: TrendPoint[]) =>
      points.reduce((s, p) => s + p.score * p.count, 0) / points.reduce((s, p) => s + p.count, 0);
    trendDelta = Math.round(mean(tail) - mean(head));
  }

  // One focus habit. Worst hit rate weighted by the outcome gap where the gap
  // is real; by hit rate alone where it is not.
  const signalValidated = checkStats.some((c) => c.significant);
  const weight = (c: CheckStat): number =>
    (1 - c.hitRate) * (signalValidated && c.significant ? 1 + Math.max(0, c.gap ?? 0) : 1);
  const candidates = checkStats.filter((c) => c.applicable >= 10);
  // A tie goes to the earlier check: that is the order the habits are taught in.
  const focus = candidates.length === 0 ? null : candidates.reduce((best, c) => (weight(c) > weight(best) ? c : best));

  const scoreValues = scored.map((e) => perPromptScore.get(e.hash)).filter((s): s is number => typeof s === 'number');

  const judged = scored.filter((e) => corrections.has(e.hash));
  const correctedCount = judged.filter((e) => corrections.get(e.hash)?.corrected).length;

  const sorted = scored.map((e) => e.ts).sort();

  return {
    promptsConsidered: entries.length,
    promptsScored: scored.length,
    sessions: new Set(scored.map((e) => e.session)).size,
    from: sorted[0] ?? null,
    to: sorted[sorted.length - 1] ?? null,
    meanScore: scoreValues.length ? Math.round(scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length) : null,
    checks: checkStats,
    trend,
    trendDelta,
    focus,
    correction: {
      available: judged.length > 0,
      judged: judged.length,
      overallRate: judged.length ? correctedCount / judged.length : null,
      signalValidated,
    },
  };
}
