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
      lines.push(`- What is missing: ${check.def.cause}`);
      lines.push(`- What goes wrong: ${check.def.consequence}`);
      lines.push(`- Do this instead: ${check.def.fix}`);
      lines.push('');
    }
  }

  const na = result.checks.filter((c) => c.verdict === 'n/a');
  if (na.length > 0) {
    lines.push(`Did not apply to this prompt: ${na.map((c) => c.label.toLowerCase()).join(', ')}.`);
    lines.push('A prompt is only judged on the habits that fit it — you are not');
    lines.push('marked down for leaving out an error message when nothing is broken.');
    lines.push('');
  }
  lines.push('The number after each line is how sure the model was, from 0 to 1.');

  lines.push('', '## Original text', '', text);
  return lines.join('\n');
}

function bar(value: number, width = 20): string {
  const filled = Math.round(value * width);
  return '#'.repeat(filled) + '.'.repeat(width - filled);
}

/** Widest label decides the column, so renaming a check cannot break alignment. */
function labelWidth(stats: CheckStat[]): number {
  return Math.max(...stats.map((s) => s.label.length)) + 1;
}

function renderCheckRow(stat: CheckStat, width: number, signalValidated: boolean): string {
  const head = `${stat.label.padEnd(width)} ${bar(stat.hitRate)} ${pct(stat.hitRate).padStart(4)}  ${stat.passed} of ${stat.applicable}`;
  if (!signalValidated || stat.correctionWhenPass === null || stat.correctionWhenFail === null) return head;
  const flag = stat.significant ? '' : '  [not significant]';
  return `${head}\n${' '.repeat(width)} corrections: ${pct(stat.correctionWhenPass)} when present vs ${pct(stat.correctionWhenFail)} when absent${flag}`;
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
  lines.push(`Average score: ${report.meanScore}/100`);
  if (report.trendDelta !== null) {
    const sign = report.trendDelta > 0 ? '+' : '';
    const direction = report.trendDelta > 0 ? 'improving' : report.trendDelta < 0 ? 'slipping' : 'flat';
    lines.push(`Over the last 30 days: ${sign}${report.trendDelta} points (${direction})`);
  }
  lines.push('');

  lines.push('## How often you do each one', '');
  const width = labelWidth(report.checks);
  for (const stat of report.checks) {
    if (stat.applicable === 0) {
      lines.push(`${stat.label.padEnd(width)} (did not apply to any prompt here)`);
      continue;
    }
    lines.push(renderCheckRow(stat, width, report.correction.signalValidated));
  }
  lines.push('');

  if (report.trend.length >= 2) {
    lines.push('## Score by day', '');
    for (const point of report.trend) {
      const prompts = point.count === 1 ? '1 prompt' : `${point.count} prompts`;
      lines.push(`${point.day}  ${bar(point.score / 100, 24)} ${String(point.score).padStart(3)}  from ${prompts}`);
    }
    lines.push('');
  }

  lines.push('## Does it make any difference?', '');
  if (!report.correction.available) {
    lines.push('Not measured yet for these prompts. A backfill fills this in.');
  } else {
    lines.push(
      `${pct(report.correction.overallRate ?? 0)} of your prompts were followed by you correcting or`,
    );
    lines.push(
      `redirecting the agent, across ${report.correction.judged} back-to-back pairs of messages.`,
    );
    lines.push('');
    if (report.correction.signalValidated) {
      const winners = report.checks.filter((c) => c.significant);
      lines.push('These habits show a real difference — prompts that have them get');
      lines.push(`corrected less often: ${winners.map((c) => c.label.toLowerCase()).join(', ')}.`);
    } else {
      lines.push('We checked whether the habits above make corrections less likely, and');
      lines.push('on your data they do not: no habit shows a difference big enough to be');
      lines.push('more than chance. So treat the numbers above as what you wrote, not as');
      lines.push('proof of what worked. Nothing here claims one causes the other.');
    }
  }
  lines.push('');

  if (report.focus) {
    lines.push('## Work on this one', '');
    lines.push(`${report.focus.label} — you do this ${pct(report.focus.hitRate)} of the time.`);
    const def = report.checks.find((c) => c.id === report.focus!.id);
    if (def && report.focus.significant && report.focus.gap !== null) {
      lines.push(
        `Prompts that miss it are corrected ${Math.round(report.focus.gap * 100)} points more often.`,
      );
    }
    lines.push('');
    lines.push('That is the one to change. Leave the rest alone until it moves.');
    lines.push('');
    lines.push('Each bar above is how often you did that thing, out of the prompts');
    lines.push('it applied to. A prompt is only judged on the habits that fit it.');
  }

  return lines.join('\n');
}
