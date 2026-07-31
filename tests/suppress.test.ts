import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  appendDismissal, isDismissalActive, readBaseline, readDismissals,
  suppressFindings, writeBaseline,
} from '../src/suppress.js';
import type { DismissalEntry } from '../src/suppress.js';
import type { ReviewerReport } from '../src/report/schema.js';

function report(reviewer: string, issues: ReviewerReport['issues']): ReviewerReport {
  return {
    schema_version: 1, reviewer, status: issues.length ? 'FAIL' : 'PASS',
    confidence: 0.9, severity: issues.length ? 'high' : 'none',
    summary: 'summary', issues,
  };
}
function issue(id: string, rule = 'SEC-001', file = 'src/a.ts'): ReviewerReport['issues'][number] {
  return { id, rule, message: 'msg', file, line: 1, severity: 'high', confidence: 0.9 };
}

let repoRoot: string;
beforeEach(() => { repoRoot = mkdtempSync(join(tmpdir(), 'revu-suppress-')); });
afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

describe('readBaseline / writeBaseline', () => {
  it('returns null when no baseline file exists', () => {
    expect(readBaseline(repoRoot)).toBeNull();
  });

  it('round-trips every finding id/rule/file across reports', () => {
    const reports = [
      report('security', [issue('aaa1', 'SEC-001', 'src/a.ts'), issue('bbb2', 'SEC-002', 'src/b.ts')]),
      report('testing', [issue('ccc3', 'TEST-001', 'src/c.ts')]),
    ];
    const written = writeBaseline(repoRoot, reports);
    expect(written.findings).toHaveLength(3);
    expect(written.generated_at).toBeTruthy();

    const read = readBaseline(repoRoot);
    expect(read).not.toBeNull();
    expect(read!.findings).toEqual([
      { id: 'aaa1', rule: 'SEC-001', file: 'src/a.ts' },
      { id: 'bbb2', rule: 'SEC-002', file: 'src/b.ts' },
      { id: 'ccc3', rule: 'TEST-001', file: 'src/c.ts' },
    ]);
  });

  it('lazily creates .review/', () => {
    expect(existsSync(join(repoRoot, '.review'))).toBe(false);
    writeBaseline(repoRoot, []);
    expect(existsSync(join(repoRoot, '.review', 'baseline.json'))).toBe(true);
  });

  it('treats a corrupt baseline file as no baseline', () => {
    const dir = join(repoRoot, '.review');
    writeBaseline(repoRoot, []);
    writeFileSync(join(dir, 'baseline.json'), 'not json');
    expect(readBaseline(repoRoot)).toBeNull();
  });
});

describe('readDismissals / appendDismissal', () => {
  it('returns [] when no dismissals file exists', () => {
    expect(readDismissals(repoRoot)).toEqual([]);
  });

  const entry: DismissalEntry = {
    id: 'aaa1', rule: 'SEC-001', reason: 'known false positive',
    approved_by: 'Ada Lovelace', expires: '2999-01-01',
  };

  it('appends and round-trips a dismissal as valid YAML', () => {
    appendDismissal(repoRoot, entry);
    const path = join(repoRoot, '.review', 'dismissals.yaml');
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    const parsed = parseYaml(raw);
    expect(parsed).toEqual([entry]);
    expect(readDismissals(repoRoot)).toEqual([entry]);
  });

  it('appends onto existing entries rather than overwriting', () => {
    appendDismissal(repoRoot, entry);
    const second: DismissalEntry = { ...entry, id: 'bbb2', reason: 'second' };
    appendDismissal(repoRoot, second);
    expect(readDismissals(repoRoot)).toEqual([entry, second]);
  });

  it('treats a corrupt dismissals file as no dismissals', () => {
    const dir = join(repoRoot, '.review');
    appendDismissal(repoRoot, entry);
    writeFileSync(join(dir, 'dismissals.yaml'), ':: not: yaml: [');
    expect(readDismissals(repoRoot)).toEqual([]);
  });
});

describe('isDismissalActive', () => {
  const base: DismissalEntry = { id: 'x', rule: 'SEC-001', reason: 'r', approved_by: 'a', expires: '2020-01-01' };
  it('is false once expires has passed', () => {
    expect(isDismissalActive({ ...base, expires: '2020-01-01' }, new Date('2026-01-01'))).toBe(false);
  });
  it('is true while expires is in the future', () => {
    expect(isDismissalActive({ ...base, expires: '2030-01-01' }, new Date('2026-01-01'))).toBe(true);
  });
  it('is false for an unparsable expires date', () => {
    expect(isDismissalActive({ ...base, expires: 'not-a-date' })).toBe(false);
  });
});

describe('suppressFindings', () => {
  it('leaves everything untouched with no baseline and no dismissals', () => {
    const reports = [report('security', [issue('aaa1')])];
    const { reports: out, suppressed } = suppressFindings(reports, null, []);
    expect(out).toEqual(reports);
    expect(suppressed).toEqual([]);
  });

  it('moves a baseline-covered finding into suppressed and out of the report', () => {
    const reports = [report('security', [issue('aaa1'), issue('bbb2')])];
    const baseline = { generated_at: 'now', findings: [{ id: 'aaa1', rule: 'SEC-001', file: 'src/a.ts' }] };
    const { reports: out, suppressed } = suppressFindings(reports, baseline, []);
    expect(out[0]!.issues.map((i) => i.id)).toEqual(['bbb2']);
    expect(suppressed).toEqual([
      { ...issue('aaa1'), reviewer: 'security', suppressed_by: 'baseline' },
    ]);
  });

  it('moves an active-dismissal-covered finding into suppressed with its reason', () => {
    const reports = [report('security', [issue('aaa1')])];
    const dismissals: DismissalEntry[] = [
      { id: 'aaa1', rule: 'SEC-001', reason: 'accepted risk', approved_by: 'ada', expires: '2999-01-01' },
    ];
    const { reports: out, suppressed } = suppressFindings(reports, null, dismissals);
    expect(out[0]!.issues).toEqual([]);
    expect(suppressed).toEqual([
      { ...issue('aaa1'), reviewer: 'security', suppressed_by: 'dismissal', reason: 'accepted risk' },
    ]);
  });

  it('does not suppress an expired dismissal', () => {
    const reports = [report('security', [issue('aaa1')])];
    const dismissals: DismissalEntry[] = [
      { id: 'aaa1', rule: 'SEC-001', reason: 'stale', approved_by: 'ada', expires: '2000-01-01' },
    ];
    const { reports: out, suppressed } = suppressFindings(reports, null, dismissals, new Date('2026-01-01'));
    expect(out[0]!.issues.map((i) => i.id)).toEqual(['aaa1']);
    expect(suppressed).toEqual([]);
  });

  it('an active dismissal takes precedence over a baseline entry for the same id', () => {
    const reports = [report('security', [issue('aaa1')])];
    const baseline = { generated_at: 'now', findings: [{ id: 'aaa1', rule: 'SEC-001', file: 'src/a.ts' }] };
    const dismissals: DismissalEntry[] = [
      { id: 'aaa1', rule: 'SEC-001', reason: 'documented', approved_by: 'ada', expires: '2999-01-01' },
    ];
    const { suppressed } = suppressFindings(reports, baseline, dismissals);
    expect(suppressed).toEqual([
      { ...issue('aaa1'), reviewer: 'security', suppressed_by: 'dismissal', reason: 'documented' },
    ]);
  });

  it('leaves reports without any suppressed issues referentially untouched', () => {
    const reports = [report('security', [issue('aaa1')])];
    const { reports: out } = suppressFindings(reports, null, []);
    expect(out[0]).toBe(reports[0]);
  });
});
