import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runPipeline } from '../src/pipeline.js';
import { appendDismissal, writeBaseline } from '../src/suppress.js';
import { makeTmpRepo } from './helpers/tmprepo.js';

const SHIM = resolve('tests/fixtures/fake-claude.mjs');
let repo: ReturnType<typeof makeTmpRepo>;

function setupReviewDir(root: string) {
  const rd = join(root, '.review');
  mkdirSync(join(rd, 'rules', 'security'), { recursive: true });
  mkdirSync(join(rd, 'reviewers'), { recursive: true });
  writeFileSync(join(rd, 'config.yaml'), [
    'schema_version: 1',
    'reviewers:',
    '  - id: security',
    '    tier: 1',
    '    rules: rules/security/**',
    '    min_confidence_to_block: 0.7',
  ].join('\n'));
  writeFileSync(join(rd, 'rules', 'security', 'SEC-001.md'),
    '---\nid: SEC-001\ntitle: No eval\ndomain: security\nseverity: high\nblocking: true\nstatus: active\n---\n\nNever eval user input.\n');
  writeFileSync(join(rd, 'reviewers', 'security.md'),
    '---\nid: security\n---\n\nYou review changes for security only.\n');
}

const env = (mode: string, extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH!, HOME: process.env.HOME!,
  REVU_CLAUDE_BIN: SHIM, REVU_CONFIG_HOME: '/nonexistent-global',
  FAKE_CLAUDE_MODE: mode, ...extra,
});

beforeEach(() => {
  repo = makeTmpRepo();
  repo.commit('src/a.ts', 'const x = 1;\n', 'base');
  setupReviewDir(repo.root);
  repo.commitAll('add review config');
  repo.branch('feature');
  // fake-claude's 'fail' mode always cites file src/a.ts line 2.
  repo.commit('src/a.ts', 'const x = 1;\neval(input);\n', 'introduce eval');
});
afterEach(() => repo.cleanup());

describe('runPipeline baseline suppression round trip', () => {
  it('a FAILing finding is suppressed and the run PASSes once it is baselined', async () => {
    const first = await runPipeline(repo.root, {}, env('fail'));
    expect(first.exitCode).toBe(1);
    expect(first.envelope.status).toBe('FAIL');
    expect(first.envelope.suppressed).toEqual([]);
    const findingId = first.envelope.reviews[0]!.issues[0]!.id;

    // Mimic `revu --baseline`: run with suppression disabled, then record every finding.
    const baselineRun = await runPipeline(repo.root, { suppress: false }, env('fail'));
    const baseline = writeBaseline(repo.root, baselineRun.envelope.reviews);
    expect(baseline.findings).toEqual([{ id: findingId, rule: 'SEC-001', file: 'src/a.ts' }]);

    const second = await runPipeline(repo.root, {}, env('fail'));
    expect(second.envelope.status).toBe('PASS');
    expect(second.exitCode).toBe(0);
    expect(second.envelope.reviews[0]!.issues).toEqual([]);
    expect(second.envelope.suppressed).toEqual([
      { id: findingId, rule: 'SEC-001', message: 'eval of user input', file: 'src/a.ts',
        line: 2, line_end: 2, severity: 'high', confidence: 0.97,
        suggestion: 'Parse the input instead of evaluating it.',
        fix: { line: 2, line_end: 2, replacement: 'JSON.parse(input);', original: 'eval(input);' },
        reviewer: 'security', suppressed_by: 'baseline' },
    ]);
  });

  it('--baseline mode (suppress: false) records findings even when a baseline already suppresses them', async () => {
    const first = await runPipeline(repo.root, {}, env('fail'));
    const findingId = first.envelope.reviews[0]!.issues[0]!.id;
    writeBaseline(repo.root, first.envelope.reviews);

    // Without suppress:false this run would show 0 findings (suppressed by baseline);
    // --baseline mode must still see and re-record the underlying finding.
    const rerun = await runPipeline(repo.root, { suppress: false }, env('fail'));
    expect(rerun.envelope.reviews[0]!.issues.map((i) => i.id)).toEqual([findingId]);
    expect(rerun.envelope.suppressed).toEqual([]);
  });
});

describe('runPipeline dismissal suppression', () => {
  it('an active dismissal suppresses the finding and reports PASS', async () => {
    const first = await runPipeline(repo.root, {}, env('fail'));
    const findingId = first.envelope.reviews[0]!.issues[0]!.id;
    appendDismissal(repo.root, {
      id: findingId, rule: 'SEC-001', reason: 'accepted risk',
      approved_by: 'test', expires: '2999-01-01',
    });

    const second = await runPipeline(repo.root, {}, env('fail'));
    expect(second.envelope.status).toBe('PASS');
    expect(second.exitCode).toBe(0);
    expect(second.envelope.suppressed).toEqual([
      { id: findingId, rule: 'SEC-001', message: 'eval of user input', file: 'src/a.ts',
        line: 2, line_end: 2, severity: 'high', confidence: 0.97,
        suggestion: 'Parse the input instead of evaluating it.',
        fix: { line: 2, line_end: 2, replacement: 'JSON.parse(input);', original: 'eval(input);' },
        reviewer: 'security', suppressed_by: 'dismissal', reason: 'accepted risk' },
    ]);
  });

  it('an expired dismissal reactivates the finding', async () => {
    const first = await runPipeline(repo.root, {}, env('fail'));
    const findingId = first.envelope.reviews[0]!.issues[0]!.id;
    appendDismissal(repo.root, {
      id: findingId, rule: 'SEC-001', reason: 'accepted risk, expired now',
      approved_by: 'test', expires: '2000-01-01',
    });

    const second = await runPipeline(repo.root, {}, env('fail'));
    expect(second.envelope.status).toBe('FAIL');
    expect(second.exitCode).toBe(1);
    expect(second.envelope.suppressed).toEqual([]);
    expect(second.envelope.reviews[0]!.issues[0]!.id).toBe(findingId);
  });
});
