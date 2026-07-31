import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableFindingId, validateReviewerOutput } from '../src/report/validate.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'revu-rep-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'const x = 1;\neval(input); // dangerous\nconst y = 2;\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const modelReport = {
  schema_version: 1, reviewer: 'security', status: 'FAIL', confidence: 0.97,
  severity: 'high', summary: 'eval on user input',
  issues: [{ rule: 'SEC-001', message: 'eval of user input', file: 'src/a.ts',
    line: 2, line_end: 2, severity: 'high', confidence: 0.97 }],
};
const envelope = (result: string) => JSON.stringify({ result, total_cost_usd: 0.12 });
const ctx = () => ({ reviewerId: 'security', diffFiles: ['src/a.ts'], ruleIds: new Set(['SEC-001']), repoRoot: root });

describe('stableFindingId', () => {
  it('is 8 hex chars and whitespace/comment-insensitive', () => {
    const a = stableFindingId('SEC-001', 'src/a.ts', 'eval(input); // dangerous');
    const b = stableFindingId('SEC-001', 'src/a.ts', '  eval( input );');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(a).toBe(b);
    expect(stableFindingId('SEC-002', 'src/a.ts', 'eval(input);')).not.toBe(a);
  });
});

describe('validateReviewerOutput', () => {
  it('accepts a valid fenced report and computes issue ids', () => {
    const out = validateReviewerOutput(
      envelope('```json\n' + JSON.stringify(modelReport) + '\n```'), ctx());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.report.issues[0]!.id).toMatch(/^[0-9a-f]{8}$/);
      expect(out.costUsd).toBe(0.12);
    }
  });
  it('rejects non-JSON result text', () => {
    const out = validateReviewerOutput(envelope('I found some issues!'), ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/JSON/);
  });
  it('rejects unknown rule ids', () => {
    const bad = { ...modelReport, issues: [{ ...modelReport.issues[0]!, rule: 'NOPE-1' }] };
    const out = validateReviewerOutput(envelope(JSON.stringify(bad)), ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/NOPE-1/);
  });
  it('drops issues outside the diff', () => {
    const bad = { ...modelReport, issues: [{ ...modelReport.issues[0]!, file: 'src/other.ts' }] };
    const out = validateReviewerOutput(envelope(JSON.stringify(bad)), ctx());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.report.issues).toHaveLength(0);
  });
  it('drops out-of-diff issues before checking rules, silencing unknown rule errors', () => {
    const bad = { ...modelReport, issues: [{ ...modelReport.issues[0]!, file: 'src/other.ts', rule: 'NOPE-1' }] };
    const out = validateReviewerOutput(envelope(JSON.stringify(bad)), ctx());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.report.issues).toHaveLength(0);
  });
  it('rejects schema violations with a path-level message', () => {
    const bad = { ...modelReport, confidence: 'very high' };
    const out = validateReviewerOutput(envelope(JSON.stringify(bad)), ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/confidence/);
  });
});
