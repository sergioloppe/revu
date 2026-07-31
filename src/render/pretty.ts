import type { AggregateEnvelope } from '../report/envelope.js';

const ESC = String.fromCharCode(27) + '[';
const CODES = { red: '31m', yellow: '33m', green: '32m', dim: '2m', bold: '1m' };
type Code = keyof typeof CODES;

export function renderPretty(envelope: AggregateEnvelope, useColor: boolean): string {
  const c = (code: Code, s: string) => (useColor ? `${ESC}${CODES[code]}${s}${ESC}0m` : s);
  const statusColor: Code =
    envelope.status === 'FAIL' ? 'red' : envelope.status === 'PASS' ? 'green' : 'yellow';
  const lines: string[] = [];

  lines.push(c('bold', c(statusColor, `revu ${envelope.status}`)) + ` - ${envelope.decision_reason}`);
  lines.push('');
  if (envelope.tier_0) {
    const t0 = envelope.tier_0;
    const t0Color: Code = t0.status === 'FAIL' ? 'red' : 'green';
    lines.push(c('bold', c(t0Color, `tier 0: ${t0.status}`)) + c('dim', ` (${t0.checks.length} check(s))`));
    for (const check of t0.checks) {
      lines.push(`  ${check.id}: ${check.status} (${check.duration_ms}ms)`);
    }
    lines.push('');
  }
  for (const review of envelope.reviews) {
    lines.push(c('bold', `${review.reviewer}: ${review.status}`) + c('dim', ` (confidence ${review.confidence})`));
    if (review.summary) lines.push(`  ${review.summary}`);
    for (const issue of review.issues) {
      lines.push(`  ${issue.file}:${issue.line} [${issue.rule}] ${issue.severity} - ${issue.message}`);
      if (issue.suggestion) lines.push(c('dim', `    fix: ${issue.suggestion}`));
      if (issue.fix) {
        const range = issue.fix.line === issue.fix.line_end
          ? `line ${issue.fix.line}`
          : `lines ${issue.fix.line}-${issue.fix.line_end}`;
        lines.push(c('dim', `    suggested change (${range}):`));
        for (const l of issue.fix.original.split('\n')) lines.push(c('red', `      - ${l}`));
        for (const l of issue.fix.replacement.split('\n')) lines.push(c('green', `      + ${l}`));
      }
    }
    lines.push('');
  }
  // Optional-chained: `.review-report.json` files written by an older revu predate
  // this field, and re-rendering one shouldn't crash.
  const skipped = envelope.skipped_tiers ?? [];
  if (skipped.length > 0) {
    lines.push(c('yellow',
      `tier ${skipped.join(', ')} SKIPPED — those gates did not run for this result`));
    lines.push('');
  }
  const excluded = envelope.excluded_paths ?? [];
  if (excluded.length > 0) {
    lines.push(c('dim',
      `${excluded.length} secret-bearing path(s) withheld from review: ${excluded.join(', ')}`));
  }
  if (envelope.suppressed.length > 0) {
    lines.push(c('dim', `${envelope.suppressed.length} finding(s) suppressed (baseline/dismissals)`));
  }
  const cost = envelope.cost.usd === null ? 'n/a' : `$${envelope.cost.usd.toFixed(2)}`;
  lines.push(c('dim',
    `${(envelope.duration_ms / 1000).toFixed(1)}s | cost ${cost} (${envelope.auth_mode}) | layers: ${envelope.config_layers.join('+')}`));
  return lines.join('\n');
}
