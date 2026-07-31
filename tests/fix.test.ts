import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateReviewerOutput } from '../src/report/validate.js';
import { renderPretty } from '../src/render/pretty.js';
import { MAX_FIX_LINES } from '../src/constants.js';
import type { AggregateEnvelope } from '../src/report/envelope.js';

let root: string;
const FILE_BODY = 'const x = 1;\neval(input);\nconst y = 2;\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'revu-fix-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), FILE_BODY);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function validate(fix: unknown, issueOverrides: Record<string, unknown> = {}) {
  const report = {
    schema_version: 1, reviewer: 'security', status: 'FAIL', confidence: 0.9,
    severity: 'high', summary: 's',
    issues: [{
      rule: 'SEC-001', message: 'eval of user input', file: 'src/a.ts',
      line: 2, severity: 'high', confidence: 0.95, ...issueOverrides,
      ...(fix === undefined ? {} : { fix }),
    }],
  };
  const result = validateReviewerOutput(
    JSON.stringify({ result: JSON.stringify(report), total_cost_usd: 0.01 }),
    { reviewerId: 'security', diffFiles: ['src/a.ts'], ruleIds: new Set(['SEC-001']), repoRoot: root },
  );
  if (!result.ok) throw new Error(result.error);
  return result.report.issues[0]!;
}

describe('suggested fixes', () => {
  it('resolves a fix against the file and captures what it replaces', () => {
    const issue = validate({ line: 2, line_end: 2, replacement: 'JSON.parse(input);' });
    expect(issue.fix).toEqual({
      line: 2, line_end: 2, replacement: 'JSON.parse(input);', original: 'eval(input);',
    });
  });

  it('defaults the range to the issue line when the fix omits it', () => {
    const issue = validate({ replacement: 'JSON.parse(input);' });
    expect(issue.fix?.line).toBe(2);
    expect(issue.fix?.line_end).toBe(2);
    expect(issue.fix?.original).toBe('eval(input);');
  });

  it('replaces a multi-line range', () => {
    const issue = validate({ line: 1, line_end: 2, replacement: 'const x = 1;\nJSON.parse(input);' });
    expect(issue.fix?.original).toBe('const x = 1;\neval(input);');
  });

  // A fix that cannot be applied is worse than none: it sends the reader to a line
  // that doesn't say what the reviewer claimed.
  it.each([
    ['a range past the end of the file', { line: 99, line_end: 99, replacement: 'x' }],
    ['an inverted range', { line: 3, line_end: 1, replacement: 'x' }],
    ['a no-op replacement', { line: 2, line_end: 2, replacement: 'eval(input);' }],
    ['a replacement longer than the cap',
      { line: 2, line_end: 2, replacement: Array(MAX_FIX_LINES + 1).fill('x').join('\n') }],
    ['a replaced range longer than the cap',
      { line: 1, line_end: MAX_FIX_LINES + 2, replacement: 'x' }],
  ])('drops the fix but keeps the finding for %s', (_label, fix) => {
    const issue = validate(fix);
    expect(issue.fix).toBeUndefined();
    expect(issue.rule).toBe('SEC-001'); // the finding itself survives
  });

  it('drops the fix when the cited file cannot be read', () => {
    const issue = validate({ replacement: 'x' }, { file: 'src/a.ts' });
    rmSync(join(root, 'src', 'a.ts'));
    const reread = validateReviewerOutput(
      JSON.stringify({
        result: JSON.stringify({
          schema_version: 1, reviewer: 'security', status: 'FAIL', confidence: 0.9,
          severity: 'high', summary: 's',
          issues: [{ rule: 'SEC-001', message: 'm', file: 'src/a.ts', line: 2,
            severity: 'high', confidence: 0.95, fix: { replacement: 'x' } }],
        }),
        total_cost_usd: 0.01,
      }),
      { reviewerId: 'security', diffFiles: ['src/a.ts'], ruleIds: new Set(['SEC-001']), repoRoot: root },
    );
    expect(issue.fix).toBeDefined(); // it resolved while the file existed
    if (!reread.ok) throw new Error(reread.error);
    expect(reread.report.issues[0]!.fix).toBeUndefined();
  });

  it('renders the fix as a before/after block', () => {
    const issue = validate({ line: 2, line_end: 2, replacement: 'JSON.parse(input);' });
    const envelope = {
      schema_version: 1, revu_version: '0.0.0', generated_at: '', repo: 'r',
      commit: 'c', base: 'b', ruleset_hash: '', config_hash: '',
      config_layers: ['repo'], auth_mode: 'subscription', status: 'FAIL',
      decision_reason: 'r', tier_0: null, suppressed: [], excluded_paths: [],
      reviews: [{
        schema_version: 1, reviewer: 'security', status: 'FAIL', confidence: 0.9,
        severity: 'high', summary: 's', issues: [issue],
      }],
      cost: { usd: 0.01 }, duration_ms: 1,
    } as unknown as AggregateEnvelope;

    const out = renderPretty(envelope, false);
    expect(out).toContain('suggested change (line 2):');
    expect(out).toContain('- eval(input);');
    expect(out).toContain('+ JSON.parse(input);');
  });
});
