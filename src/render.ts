/** Plain-text rendering. The commands print this straight through. */
import type { PromptScore } from './score.js';
import type { Report, CheckStat } from './report.js';

const pct = (v: number): string => `${Math.round(v * 100)}%`;

export function renderScore(text: string, result: PromptScore): string {
  const lines: string[] = [];
  const score = result.score === null ? 'n/a' : `${result.score}/100`;
  lines.push(`# Prompt score: ${score}`, '');

  for (const check of result.checks) {
    const mark =
      check.verdict === 'pass' ? 'PASS' :
      check.verdict === 'fail' ? 'FAIL' :
      check.verdict === 'n/a' ? ' n/a' : '  ? ';
    const p = check.probability === null ? '' : `  (${check.probability.toFixed(2)})`;
    lines.push(`${mark}  ${check.label}${p}`);
  }

  const failures = result.checks.filter((c) => c.verdict === 'fail');
  if (failures.length === 0) {
    lines.push('', 'Nothing to fix. Every applicable check passed.');
  } else {
    lines.push('', '## What to fix', '');
    for (const check of failures) {
      lines.push(`### ${check.label}`);
      lines.push(`- Cause: ${check.def.cause}`);
      lines.push(`- Consequence: ${check.def.consequence}`);
      lines.push(`- Fix: ${check.def.fix}`);
      lines.push('');
    }
  }

  const na = result.checks.filter((c) => c.verdict === 'n/a');
  if (na.length > 0) {
    lines.push(`Not applicable to this prompt: ${na.map((c) => c.label).join(', ')}.`);
  }

  lines.push('', '## Original text', '', text);
  return lines.join('\n');
}

function bar(value: number, width = 20): string {
  const filled = Math.round(value * width);
  return '#'.repeat(filled) + '.'.repeat(width - filled);
}

function renderCheckRow(stat: CheckStat, signalValidated: boolean): string {
  const head = `${stat.label.padEnd(26)} ${bar(stat.hitRate)} ${pct(stat.hitRate).padStart(4)}  (${stat.passed}/${stat.applicable})`;
  if (!signalValidated || stat.correctionWhenPass === null || stat.correctionWhenFail === null) return head;
  const flag = stat.significant ? '' : '  [not significant]';
  return `${head}\n${' '.repeat(28)}corrections: ${pct(stat.correctionWhenPass)} when it passes vs ${pct(stat.correctionWhenFail)} when it fails${flag}`;
}

export function renderReport(report: Report, requested: number): string {
  const lines: string[] = [];
  lines.push(`# Prompt habits — last ${Math.min(requested, report.promptsScored)} scored prompts`, '');

  if (report.promptsScored === 0) {
    lines.push('No scored prompts yet.', '');
    lines.push('Run /jevpromptcoach:config to backfill from your existing Claude Code history,');
    lines.push('or keep working — prompts are logged as you go and scored when you ask.');
    return lines.join('\n');
  }

  const range = report.from && report.to ? `${report.from.slice(0, 10)} to ${report.to.slice(0, 10)}` : '';
  lines.push(`${report.promptsScored} prompts across ${report.sessions} sessions, ${range}`);
  lines.push(`Mean score: ${report.meanScore}/100`);
  if (report.trendDelta !== null) {
    const sign = report.trendDelta > 0 ? '+' : '';
    const direction = report.trendDelta > 0 ? 'improving' : report.trendDelta < 0 ? 'slipping' : 'flat';
    lines.push(`30-day trend: ${sign}${report.trendDelta} points (${direction})`);
  }
  lines.push('');

  lines.push('## Per check', '');
  for (const stat of report.checks) {
    if (stat.applicable === 0) {
      lines.push(`${stat.label.padEnd(26)} (never applicable in this window)`);
      continue;
    }
    lines.push(renderCheckRow(stat, report.correction.signalValidated));
  }
  lines.push('');

  if (report.trend.length >= 2) {
    lines.push('## Daily score', '');
    for (const point of report.trend) {
      lines.push(`${point.day}  ${bar(point.score / 100, 24)} ${String(point.score).padStart(3)}  n=${point.count}`);
    }
    lines.push('');
  }

  lines.push('## Outcome signal', '');
  if (!report.correction.available) {
    lines.push('Correction rate not computed for this window. Run a backfill to populate it.');
  } else if (report.correction.signalValidated) {
    lines.push(
      `Across ${report.correction.judged} prompt pairs, ${pct(report.correction.overallRate ?? 0)} of prompts were followed by a correction.`,
    );
    const winners = report.checks.filter((c) => c.significant);
    lines.push(
      `Checks whose outcome gap clears significance (p < 0.05): ${winners.map((c) => c.label).join(', ')}.`,
    );
  } else {
    lines.push(
      `Across ${report.correction.judged} prompt pairs, ${pct(report.correction.overallRate ?? 0)} of prompts were followed by a correction.`,
    );
    lines.push('No check shows a correction-rate gap that clears significance on this data,');
    lines.push('so hit rates and trend are reported on their own. No correlation is claimed.');
  }
  lines.push('');

  if (report.focus) {
    lines.push('## Focus on one habit', '');
    lines.push(`${report.focus.label} — you get this right ${pct(report.focus.hitRate)} of the time.`);
    const def = report.checks.find((c) => c.id === report.focus!.id);
    if (def && report.focus.significant && report.focus.gap !== null) {
      lines.push(
        `Prompts that miss it are corrected ${Math.round(report.focus.gap * 100)} points more often.`,
      );
    }
    lines.push('');
    lines.push('That is the one to change. Leave the rest alone until it moves.');
  }

  return lines.join('\n');
}
