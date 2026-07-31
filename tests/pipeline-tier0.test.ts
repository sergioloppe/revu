import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runPipeline } from '../src/pipeline.js';
import { EXIT } from '../src/constants.js';
import { makeTmpRepo } from './helpers/tmprepo.js';

const SHIM = resolve('tests/fixtures/fake-claude.mjs');

function setupReviewDir(root: string, tiersYaml = '') {
  const rd = join(root, '.review');
  mkdirSync(join(rd, 'rules', 'security'), { recursive: true });
  mkdirSync(join(rd, 'reviewers'), { recursive: true });
  writeFileSync(join(rd, 'config.yaml'), [
    'schema_version: 1',
    tiersYaml,
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

function tiersBlock(...lines: string[]) {
  return ['tiers:', '  "0":', '    checks:', ...lines].join('\n');
}

const env = (mode: string, extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH!, HOME: process.env.HOME!,
  REVU_CLAUDE_BIN: SHIM, REVU_CONFIG_HOME: '/nonexistent-global',
  FAKE_CLAUDE_MODE: mode, ...extra,
});

let repo: ReturnType<typeof makeTmpRepo>;
let scratchDir: string;
let markerFile: string;

beforeEach(() => {
  repo = makeTmpRepo();
  repo.commit('src/a.ts', 'const x = 1;\n', 'base');
  scratchDir = mkdtempSync(join(tmpdir(), 'revu-tier0-markers-'));
  markerFile = join(scratchDir, 'markers.log');
});
afterEach(() => { repo.cleanup(); rmSync(scratchDir, { recursive: true, force: true }); });

function reviewerStarted(): boolean {
  return existsSync(markerFile) && readFileSync(markerFile, 'utf8').includes('start,');
}

describe('runPipeline tier 0', () => {
  it('has a null tier_0 in the envelope when no tier-0 checks are configured', async () => {
    setupReviewDir(repo.root);
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 2;\n', 'benign change');
    const { envelope } = await runPipeline(repo.root, {}, env('pass'));
    expect(envelope.tier_0).toBeNull();
  });

  it('pass path: runs tier-0 checks, then proceeds to spend on reviewers', async () => {
    setupReviewDir(repo.root, tiersBlock('      - id: lint', '        command: exit 0'));
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 2;\n', 'benign change');

    const { envelope, exitCode } = await runPipeline(repo.root, {}, env('pass', { FAKE_MARKER_FILE: markerFile }));

    expect(envelope.tier_0).toEqual({ status: 'PASS', checks: [{ id: 'lint', status: 'PASS', duration_ms: expect.any(Number) }] });
    expect(envelope.reviews).toHaveLength(1);
    expect(exitCode).toBe(EXIT.PASS);
    expect(reviewerStarted()).toBe(true);
  });

  it('fail-fast path: a failing tier-0 check exits 4 and spawns zero reviewers', async () => {
    setupReviewDir(repo.root, tiersBlock('      - id: lint', '        command: exit 1'));
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 2;\neval(input);\n', 'introduce eval');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { envelope, exitCode } = await runPipeline(repo.root, {}, env('fail', { FAKE_MARKER_FILE: markerFile }));

    expect(exitCode).toBe(EXIT.TIER0);
    expect(envelope.status).toBe('FAIL');
    expect(envelope.decision_reason).toBe('tier 0 check lint failed');
    expect(envelope.tier_0).toEqual({ status: 'FAIL', checks: [{ id: 'lint', status: 'FAIL', duration_ms: expect.any(Number) }] });
    expect(envelope.reviews).toEqual([]);
    expect(reviewerStarted()).toBe(false); // zero reviewer spend
    expect(errSpy).toHaveBeenCalled(); // the check's raw output is surfaced to the user
    errSpy.mockRestore();
  });

  it('fail-fast path stops before later tier-0 checks', async () => {
    setupReviewDir(repo.root, tiersBlock(
      '      - id: first', '        command: exit 1',
      '      - id: second', '        command: exit 0',
    ));
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 2;\n', 'benign change');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { envelope } = await runPipeline(repo.root, {}, env('pass'));
    errSpy.mockRestore();

    expect(envelope.tier_0!.checks.map((c) => c.id)).toEqual(['first']);
  });

  it('timeout path: a check exceeding its timeout is TIMEOUT and still exits 4', async () => {
    setupReviewDir(repo.root, tiersBlock(
      '      - id: slow', '        command: sleep 3', '        timeout_seconds: 1',
    ));
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 2;\n', 'benign change');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { envelope, exitCode } = await runPipeline(repo.root, {}, env('pass', { FAKE_MARKER_FILE: markerFile }));
    errSpy.mockRestore();

    expect(exitCode).toBe(EXIT.TIER0);
    expect(envelope.tier_0!.checks[0]).toMatchObject({ id: 'slow', status: 'TIMEOUT' });
    expect(reviewerStarted()).toBe(false);
  });

  it('--tier 0 runs only tier-0 checks: reviewers never spawn even when tier 0 passes', async () => {
    setupReviewDir(repo.root, tiersBlock('      - id: lint', '        command: exit 0'));
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 2;\neval(input);\n', 'introduce eval');

    const { envelope, exitCode } = await runPipeline(repo.root, { tier: 0 }, env('fail', { FAKE_MARKER_FILE: markerFile }));

    expect(exitCode).toBe(EXIT.PASS);
    expect(envelope.status).toBe('PASS');
    expect(envelope.reviews).toEqual([]);
    expect(envelope.tier_0).toEqual({ status: 'PASS', checks: [{ id: 'lint', status: 'PASS', duration_ms: expect.any(Number) }] });
    expect(reviewerStarted()).toBe(false);
  });

  it('--tier 0 with no tier-0 checks configured is a no-op PASS with no reviewers', async () => {
    setupReviewDir(repo.root);
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 2;\neval(input);\n', 'introduce eval');

    const { envelope, exitCode } = await runPipeline(repo.root, { tier: 0 }, env('fail', { FAKE_MARKER_FILE: markerFile }));

    expect(exitCode).toBe(EXIT.PASS);
    expect(envelope.tier_0).toBeNull();
    expect(envelope.reviews).toEqual([]);
    expect(reviewerStarted()).toBe(false);
  });
});
