import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runPipeline } from '../src/pipeline.js';
import { SecurityViolationError } from '../src/errors.js';
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
});
afterEach(() => repo.cleanup());

describe('runPipeline', () => {
  it('FAILs with exit 1 when the reviewer finds a blocking issue', async () => {
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 1;\neval(input);\n', 'introduce eval');
    const { envelope, exitCode } = await runPipeline(repo.root, {}, env('fail'));
    expect(exitCode).toBe(1);
    expect(envelope.status).toBe('FAIL');
    expect(envelope.reviews[0]!.issues[0]!.rule).toBe('SEC-001');
    expect(envelope.auth_mode).toBe('subscription');
    expect(envelope.config_layers).toEqual(['builtin', 'repo']);
  });

  it('PASSes with exit 0 on a clean diff', async () => {
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 2;\n', 'benign change');
    const { envelope, exitCode } = await runPipeline(repo.root, {}, env('pass'));
    expect(exitCode).toBe(0);
    expect(envelope.status).toBe('PASS');
  });

  it('aborts with SecurityViolationError when a reviewer mutates the repo', async () => {
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 3;\n', 'change');
    await expect(runPipeline(repo.root, {}, env('mutate', {
      FAKE_MUTATE_PATH: join(repo.root, 'evil.ts'),
    }))).rejects.toThrow(SecurityViolationError);
  });

  it('exits 2 when the reviewer output is unusable', async () => {
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 4;\n', 'change');
    const { envelope, exitCode } = await runPipeline(repo.root, {}, env('malformed-always'));
    expect(exitCode).toBe(2);
    expect(envelope.status).toBe('NEEDS_HUMAN_REVIEW');
  });
});

function setupMultiReviewerDir(root: string) {
  const rd = join(root, '.review');
  mkdirSync(join(rd, 'rules', 'security'), { recursive: true });
  mkdirSync(join(rd, 'reviewers'), { recursive: true });
  // "testing" declared before "security" in config to prove tier ordering doesn't
  // depend on declaration order: tier 1 always runs before tier 2.
  writeFileSync(join(rd, 'config.yaml'), [
    'schema_version: 1',
    'reviewers:',
    '  - id: testing',
    '    tier: 2',
    '    rules: rules/security/**',
    '    min_confidence_to_block: 0.7',
    '  - id: security',
    '    tier: 1',
    '    rules: rules/security/**',
    '    min_confidence_to_block: 0.7',
  ].join('\n'));
  writeFileSync(join(rd, 'rules', 'security', 'SEC-001.md'),
    '---\nid: SEC-001\ntitle: No eval\ndomain: security\nseverity: high\nblocking: true\nstatus: active\n---\n\nNever eval user input.\n');
  writeFileSync(join(rd, 'reviewers', 'security.md'),
    '---\nid: security\n---\n\nYou review changes for security only.\n');
  writeFileSync(join(rd, 'reviewers', 'testing.md'),
    '---\nid: testing\n---\n\nYou review changes for testing only.\n');
}

describe('runPipeline reviewer selection (--only/--skip/--tier)', () => {
  let mrepo: ReturnType<typeof makeTmpRepo>;
  beforeEach(() => {
    mrepo = makeTmpRepo();
    mrepo.commit('src/a.ts', 'const x = 1;\n', 'base');
    setupMultiReviewerDir(mrepo.root);
    mrepo.commitAll('add review config');
    mrepo.branch('feature');
    mrepo.commit('src/a.ts', 'const x = 1;\neval(input);\n', 'introduce eval');
  });
  afterEach(() => mrepo.cleanup());

  it('by default runs tier-1 reviewers before tier-2, regardless of declaration order', async () => {
    const { envelope } = await runPipeline(mrepo.root, {}, env('pass'));
    expect(envelope.reviews.map((r) => r.reviewer)).toEqual(['security', 'testing']);
  });

  it('--tier 1 restricts to reviewers at or below that tier', async () => {
    const { envelope } = await runPipeline(mrepo.root, { tier: 1 }, env('pass'));
    expect(envelope.reviews.map((r) => r.reviewer)).toEqual(['security']);
  });

  it('--skip excludes named reviewers', async () => {
    const { envelope, exitCode } = await runPipeline(mrepo.root, { skip: ['testing'] }, env('fail'));
    expect(envelope.reviews.map((r) => r.reviewer)).toEqual(['security']);
    expect(envelope.status).toBe('FAIL');
    expect(exitCode).toBe(1);
  });

  it('--only runs the named reviewer regardless of --tier, and a tier-2 FAIL is advisory only', async () => {
    const { envelope, exitCode } = await runPipeline(
      mrepo.root, { only: ['testing'], tier: 1 }, env('fail'),
    );
    expect(envelope.reviews.map((r) => r.reviewer)).toEqual(['testing']);
    // testing is tier 2: a blocking-rule FAIL from it can never fail the run
    expect(envelope.status).toBe('PASS_WITH_WARNINGS');
    expect(exitCode).toBe(0);
  });
});
