import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runPipeline } from '../src/pipeline.js';
import { makeTmpRepo } from './helpers/tmprepo.js';

const SHIM = resolve('tests/fixtures/fake-claude.mjs');

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

function env(mode: string, extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH!, HOME: process.env.HOME!,
    REVU_CLAUDE_BIN: SHIM, REVU_CONFIG_HOME: '/nonexistent-global',
    FAKE_CLAUDE_MODE: mode, ...extra,
  };
}

function startCount(markerFile: string): number {
  if (!existsSync(markerFile)) return 0;
  return readFileSync(markerFile, 'utf8').trim().split('\n').filter((l) => l.startsWith('start,')).length;
}

let repo: ReturnType<typeof makeTmpRepo>;
let scratchDir: string;
let markerFile: string;

beforeEach(() => {
  repo = makeTmpRepo();
  repo.commit('src/a.ts', 'const x = 1;\n', 'base');
  scratchDir = mkdtempSync(join(tmpdir(), 'revu-cache-markers-'));
  markerFile = join(scratchDir, 'markers.log');
});
afterEach(() => { repo.cleanup(); rmSync(scratchDir, { recursive: true, force: true }); });

describe('runPipeline review cache', () => {
  it('a second identical run hits the cache: no subprocess spawn, cached: true on the review', async () => {
    setupReviewDir(repo.root);
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 2;\n', 'benign change');

    const first = await runPipeline(repo.root, {}, env('pass', { FAKE_MARKER_FILE: markerFile }));
    expect(first.envelope.reviews).toHaveLength(1);
    expect(first.envelope.reviews[0]!.cached).toBeUndefined();
    expect(startCount(markerFile)).toBe(1);

    const second = await runPipeline(repo.root, {}, env('pass', { FAKE_MARKER_FILE: markerFile }));
    expect(second.envelope.reviews).toHaveLength(1);
    expect(second.envelope.reviews[0]!.cached).toBe(true);
    expect(second.envelope.reviews[0]!.status).toBe('PASS');
    expect(startCount(markerFile)).toBe(1); // no new spawn
  });

  it('a cache-hit run reports $0 cost, not the replayed cost of the original run', async () => {
    // The fake-claude shim reports total_cost_usd: 0.05 per actual invocation. The
    // second run here is a 100% cache hit (no subprocess spawned), so its envelope
    // cost must reflect actual spend THIS run ($0 / null), not the cached report's
    // original costUsd replayed as if it were spent again.
    setupReviewDir(repo.root);
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 10;\n', 'benign change');

    const first = await runPipeline(repo.root, {}, env('pass', { FAKE_MARKER_FILE: markerFile }));
    expect(first.envelope.cost.usd).toBeCloseTo(0.05);

    const second = await runPipeline(repo.root, {}, env('pass', { FAKE_MARKER_FILE: markerFile }));
    expect(second.envelope.reviews[0]!.cached).toBe(true);
    expect(second.envelope.cost.usd).toBeNull(); // nothing actually spent this run
  });

  it('--no-cache bypasses the read and re-runs the reviewer', async () => {
    setupReviewDir(repo.root);
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 3;\n', 'benign change');

    await runPipeline(repo.root, {}, env('pass', { FAKE_MARKER_FILE: markerFile }));
    expect(startCount(markerFile)).toBe(1);

    const second = await runPipeline(repo.root, { cache: false }, env('pass', { FAKE_MARKER_FILE: markerFile }));
    expect(startCount(markerFile)).toBe(2); // re-ran despite an existing cache entry
    expect(second.envelope.reviews[0]!.cached).toBeUndefined();

    // still writes: a subsequent run WITH cache reads what --no-cache just wrote
    const third = await runPipeline(repo.root, {}, env('pass', { FAKE_MARKER_FILE: markerFile }));
    expect(startCount(markerFile)).toBe(2);
    expect(third.envelope.reviews[0]!.cached).toBe(true);
  });

  it('a different diff misses the cache', async () => {
    setupReviewDir(repo.root);
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 4;\n', 'benign change');
    await runPipeline(repo.root, {}, env('pass', { FAKE_MARKER_FILE: markerFile }));
    expect(startCount(markerFile)).toBe(1);

    repo.commit('src/a.ts', 'const x = 5;\n', 'a different benign change');
    const second = await runPipeline(repo.root, {}, env('pass', { FAKE_MARKER_FILE: markerFile }));
    expect(startCount(markerFile)).toBe(2); // miss: different diff.patch
    expect(second.envelope.reviews[0]!.cached).toBeUndefined();
  });

  it('NEEDS_HUMAN_REVIEW reports are never cached', async () => {
    setupReviewDir(repo.root);
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 6;\n', 'benign change');

    // 'malformed-always' fails schema validation twice per runPipeline call (initial +
    // one retry inside runReviewer), so each call spawns the shim twice.
    const first = await runPipeline(repo.root, {}, env('malformed-always', { FAKE_MARKER_FILE: markerFile }));
    expect(first.envelope.reviews[0]!.status).toBe('NEEDS_HUMAN_REVIEW');
    expect(startCount(markerFile)).toBe(2);

    const second = await runPipeline(repo.root, {}, env('malformed-always', { FAKE_MARKER_FILE: markerFile }));
    expect(second.envelope.reviews[0]!.status).toBe('NEEDS_HUMAN_REVIEW');
    expect(second.envelope.reviews[0]!.cached).toBeUndefined();
    expect(startCount(markerFile)).toBe(4); // no cache hit: re-ran (2 more spawns)
  });

  it('lazily creates .review/cache/reviews on first write', async () => {
    setupReviewDir(repo.root);
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 7;\n', 'benign change');
    expect(existsSync(join(repo.root, '.review', 'cache'))).toBe(false);
    await runPipeline(repo.root, {}, env('pass', { FAKE_MARKER_FILE: markerFile }));
    expect(existsSync(join(repo.root, '.review', 'cache', 'reviews'))).toBe(true);
  });

  it('editing the reviewer persona body misses the cache on the next run', async () => {
    // The cache key hashes the FULL compiled prompt (reviewerId + model + prompt),
    // not just reviewerId/model/rules/diff — so a persona edit, which changes the
    // compiled prompt but touches neither the diff nor the rule catalog, must still
    // invalidate the cache. Otherwise a stale report keeps getting served forever.
    setupReviewDir(repo.root);
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 8;\n', 'benign change');

    await runPipeline(repo.root, {}, env('pass', { FAKE_MARKER_FILE: markerFile }));
    expect(startCount(markerFile)).toBe(1);

    writeFileSync(join(repo.root, '.review', 'reviewers', 'security.md'),
      '---\nid: security\n---\n\nYou review changes for security only. Now with extra scrutiny.\n');

    const second = await runPipeline(repo.root, {}, env('pass', { FAKE_MARKER_FILE: markerFile }));
    expect(startCount(markerFile)).toBe(2); // persona edit: miss, re-ran
    expect(second.envelope.reviews[0]!.cached).toBeUndefined();
  });

  it('editing injected skill content misses the cache on the next run', async () => {
    // Skill content is folded into the compiled prompt as extra context docs (see
    // pipeline-skills.test.ts); it must participate in the cache key the same way
    // persona and context docs do.
    const rd = join(repo.root, '.review');
    mkdirSync(join(rd, 'rules', 'security'), { recursive: true });
    mkdirSync(join(rd, 'reviewers'), { recursive: true });
    writeFileSync(join(rd, 'config.yaml'), [
      'schema_version: 1',
      'reviewers:',
      '  - id: security',
      '    tier: 1',
      '    rules: rules/security/**',
      '    min_confidence_to_block: 0.7',
      'context:',
      '  skills:',
      '    - source: superpowers',
      '      include: [test-driven-development]',
      '      reviewers: [security]',
    ].join('\n'));
    writeFileSync(join(rd, 'rules', 'security', 'SEC-001.md'),
      '---\nid: SEC-001\ntitle: No eval\ndomain: security\nseverity: high\nblocking: true\nstatus: active\n---\n\nNever eval user input.\n');
    writeFileSync(join(rd, 'reviewers', 'security.md'),
      '---\nid: security\n---\n\nYou review changes for security only.\n');
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 9;\n', 'benign change');

    const skillsHomeDir = mkdtempSync(join(tmpdir(), 'revu-cache-skillshome-'));
    mkdirSync(join(skillsHomeDir, 'superpowers', 'test-driven-development'), { recursive: true });
    writeFileSync(join(skillsHomeDir, 'superpowers', 'test-driven-development', 'SKILL.md'), 'SKILL-V1');
    try {
      await runPipeline(repo.root, {},
        env('pass', { FAKE_MARKER_FILE: markerFile, REVU_SKILLS_HOME: skillsHomeDir }));
      expect(startCount(markerFile)).toBe(1);

      writeFileSync(join(skillsHomeDir, 'superpowers', 'test-driven-development', 'SKILL.md'), 'SKILL-V2');

      const second = await runPipeline(repo.root, {},
        env('pass', { FAKE_MARKER_FILE: markerFile, REVU_SKILLS_HOME: skillsHomeDir }));
      expect(startCount(markerFile)).toBe(2); // skill content edit: miss, re-ran
      expect(second.envelope.reviews[0]!.cached).toBeUndefined();
    } finally {
      rmSync(skillsHomeDir, { recursive: true, force: true });
    }
  });
});
