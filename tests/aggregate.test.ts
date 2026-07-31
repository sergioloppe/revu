import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { aggregate } from '../src/aggregate/aggregate.js';
import { buildEnvelope } from '../src/report/envelope.js';
import type { ReviewerReport } from '../src/report/schema.js';
import type { Rule } from '../src/catalog/rules.js';
import { ConfigSchema, type ReviewerConfig } from '../src/config/schema.js';

const rule = (id: string, blocking: boolean): Rule => ({
  id, title: 't', domain: 'security', severity: 'high', blocking, status: 'active',
  applies_to: ['**'], exceptions: [], body: 'b', origin: 'repo', relPath: `security/${id}.md`,
});
const reviewer: ReviewerConfig = {
  id: 'security', tier: 1, rules: 'rules/security/**', context: [],
  model: 'claude-opus-4-8', min_confidence_to_block: 0.7,
};
const report = (over: Partial<ReviewerReport>): ReviewerReport => ({
  schema_version: 1, reviewer: 'security', status: 'FAIL', confidence: 0.9,
  severity: 'high', summary: 's',
  issues: [{ id: 'aaaa1111', rule: 'SEC-001', message: 'm', file: 'src/a.ts', line: 2,
    severity: 'high', confidence: 0.9 }],
  ...over,
});
const rules = new Map([['SEC-001', rule('SEC-001', true)]]);

describe('aggregate', () => {
  it('FAILs on a confident blocking high-severity finding', () => {
    const res = aggregate([report({})], [reviewer], rules, 'high');
    expect(res.status).toBe('FAIL');
    expect(res.exitCode).toBe(1);
    expect(res.decision_reason).toContain('security');
  });
  it('demotes findings below the reviewer confidence gate (still warns)', () => {
    const low = report({ issues: [{ ...report({}).issues[0]!, confidence: 0.5 }] });
    const res = aggregate([low], [reviewer], rules, 'high');
    expect(res.status).toBe('PASS_WITH_WARNINGS');
    expect(res.exitCode).toBe(0);
    expect(res.demoted).toEqual(['aaaa1111']);
  });
  it('advisory rules never fail the run', () => {
    const res = aggregate([report({})], [reviewer], new Map([['SEC-001', rule('SEC-001', false)]]), 'high');
    expect(res.status).toBe('PASS_WITH_WARNINGS');
  });
  it('severity below the gate does not fail', () => {
    const med = report({ issues: [{ ...report({}).issues[0]!, severity: 'medium' }] });
    expect(aggregate([med], [reviewer], rules, 'high').status).toBe('PASS_WITH_WARNINGS');
  });
  it('NEEDS_HUMAN_REVIEW propagates with exit 2', () => {
    const res = aggregate([report({ status: 'NEEDS_HUMAN_REVIEW', issues: [] })], [reviewer], rules, 'high');
    expect(res.status).toBe('NEEDS_HUMAN_REVIEW');
    expect(res.exitCode).toBe(2);
  });
  it('clean pass', () => {
    const res = aggregate([report({ status: 'PASS', issues: [], severity: 'none' })], [reviewer], rules, 'high');
    expect(res.status).toBe('PASS');
    expect(res.exitCode).toBe(0);
  });
  it('does not demote issues excluded by severity alone (even with low confidence)', () => {
    const med = report({ issues: [{ ...report({}).issues[0]!, severity: 'medium', confidence: 0.5 }] });
    const res = aggregate([med], [reviewer], rules, 'high');
    expect(res.status).toBe('PASS_WITH_WARNINGS');
    expect(res.demoted).toEqual([]);
  });
  it('a tier-2 reviewer FAIL is advisory only: never blocks, even with a confident blocking rule', () => {
    const tier2Reviewer: ReviewerConfig = { ...reviewer, id: 'performance', tier: 2 };
    const tier2Report = report({ reviewer: 'performance' });
    const res = aggregate([tier2Report], [tier2Reviewer], rules, 'high');
    expect(res.status).toBe('PASS_WITH_WARNINGS');
    expect(res.exitCode).toBe(0);
  });
});

describe('buildEnvelope', () => {
  it('produces stable hashes and records provenance', () => {
    const config = ConfigSchema.parse({ schema_version: 1 });
    const input = {
      repoRoot: '/tmp/x/orders-service', commit: 'c'.repeat(40), base: 'b'.repeat(40),
      config, layers: ['builtin', 'repo'] as Array<'builtin' | 'repo'>,
      authMode: 'subscription' as const, rules: [rule('SEC-001', true)],
      reports: [report({})],
      result: { status: 'FAIL' as const, decision_reason: 'r', exitCode: 1, demoted: [] as string[] },
      costUsd: 0.05, durationMs: 1234,
    };
    const env1 = buildEnvelope(input);
    const env2 = buildEnvelope(input);
    expect(env1.config_hash).toBe(env2.config_hash);
    expect(env1.ruleset_hash).toBe(env2.ruleset_hash);
    expect(env1.config_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(env1.repo).toBe('orders-service');
    expect(env1.auth_mode).toBe('subscription');
    expect(env1.config_layers).toEqual(['builtin', 'repo']);
    // Read from package.json, not hardcoded: a literal here turns every version bump
    // into a failing test, which is exactly what single-sourcing the version removed.
    expect(env1.revu_version).toBe(
      JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version);
  });
});
