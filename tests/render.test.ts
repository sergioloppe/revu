import { describe, it, expect } from 'vitest';
import { renderPretty } from '../src/render/pretty.js';
import type { AggregateEnvelope } from '../src/report/envelope.js';

const ESC_CHAR = String.fromCharCode(27);

const envelope: AggregateEnvelope = {
  schema_version: 1, revu_version: '0.1.0', generated_at: '2026-07-19T00:00:00Z',
  repo: 'demo', commit: 'c'.repeat(40), base: 'b'.repeat(40),
  ruleset_hash: 'sha256:' + '0'.repeat(64), config_hash: 'sha256:' + '0'.repeat(64),
  config_layers: ['builtin', 'repo'], auth_mode: 'subscription',
  status: 'FAIL', decision_reason: 'security reported 1 blocking issue(s) at or above high',
  tier_0: null, suppressed: [], excluded_paths: [],
  reviews: [{
    schema_version: 1, reviewer: 'security', status: 'FAIL', confidence: 0.95,
    severity: 'high', summary: 'eval on user input',
    issues: [{ id: 'aaaa1111', rule: 'SEC-001', message: 'eval of user input',
      file: 'src/a.ts', line: 2, severity: 'high', confidence: 0.97,
      suggestion: 'Use JSON.parse instead.' }],
  }],
  cost: { usd: 0.05 }, duration_ms: 42000,
};

describe('renderPretty', () => {
  const plain = renderPretty(envelope, false);
  it('shows the status and decision reason', () => {
    expect(plain).toContain('FAIL');
    expect(plain).toContain('security reported 1 blocking issue(s)');
  });
  it('shows findings with location, rule, and suggestion', () => {
    expect(plain).toContain('src/a.ts:2');
    expect(plain).toContain('[SEC-001]');
    expect(plain).toContain('eval of user input');
    expect(plain).toContain('Use JSON.parse instead.');
  });
  it('shows duration, cost, and auth mode in the footer', () => {
    expect(plain).toMatch(/42\.0s/);
    expect(plain).toMatch(/\$0\.05/);
    expect(plain).toContain('subscription');
  });
  it('emits no ANSI codes when color is off', () => {
    expect(plain).not.toContain(ESC_CHAR);
  });
  it('emits ANSI codes when color is on', () => {
    expect(renderPretty(envelope, true)).toContain(ESC_CHAR);
  });
  it('renders null cost as n/a in the footer', () => {
    const nullCostEnvelope = { ...envelope, cost: { usd: null } };
    const output = renderPretty(nullCostEnvelope, false);
    expect(output).toContain('cost n/a');
  });
  it('renders different status values', () => {
    const passEnvelope = { ...envelope, status: 'PASS' as const, decision_reason: 'no findings', reviews: [] };
    const passOutput = renderPretty(passEnvelope, false);
    expect(passOutput).toContain('revu PASS');

    const humanReviewEnvelope = { ...envelope, status: 'NEEDS_HUMAN_REVIEW' as const };
    const humanReviewOutput = renderPretty(humanReviewEnvelope, false);
    expect(humanReviewOutput).toContain('revu NEEDS_HUMAN_REVIEW');
  });
  it('omits the tier-0 section when tier_0 is null', () => {
    expect(plain).not.toContain('tier 0:');
  });
  it('shows tier-0 status and per-check results when tier_0 is non-null', () => {
    const withTier0 = {
      ...envelope,
      tier_0: {
        status: 'PASS' as const,
        checks: [
          { id: 'lint', status: 'PASS' as const, duration_ms: 120 },
          { id: 'typecheck', status: 'PASS' as const, duration_ms: 900 },
        ],
      },
    };
    const output = renderPretty(withTier0, false);
    expect(output).toContain('tier 0: PASS');
    expect(output).toContain('lint: PASS (120ms)');
    expect(output).toContain('typecheck: PASS (900ms)');
  });
  it('shows a FAILing tier-0 check', () => {
    const withFailingTier0 = {
      ...envelope,
      tier_0: { status: 'FAIL' as const, checks: [{ id: 'lint', status: 'FAIL' as const, duration_ms: 50 }] },
    };
    const output = renderPretty(withFailingTier0, false);
    expect(output).toContain('tier 0: FAIL');
    expect(output).toContain('lint: FAIL (50ms)');
  });
  it('omits the suppressed line when nothing is suppressed', () => {
    expect(plain).not.toContain('suppressed');
  });
  it('shows a suppressed-count line when findings were suppressed', () => {
    const withSuppressed = {
      ...envelope,
      suppressed: [
        { id: 'aaaa1111', rule: 'SEC-001', file: 'src/a.ts', line: 2, suppressed_by: 'baseline' as const },
      ],
    };
    const output = renderPretty(withSuppressed, false);
    expect(output).toContain('1 finding(s) suppressed (baseline/dismissals)');
  });
  it('handles missing suggestion and empty summary', () => {
    const { suggestion: _, ...issueWithoutSuggestion } = envelope.reviews[0].issues[0];
    const noSuggestionEnvelope = {
      ...envelope,
      reviews: [{
        ...envelope.reviews[0],
        summary: '',
        issues: [issueWithoutSuggestion],
      }],
    };
    const output = renderPretty(noSuggestionEnvelope, false);
    expect(output).toContain('src/a.ts:2');
    expect(output).toContain('[SEC-001]');
    expect(output).not.toContain('fix:');
  });
});
