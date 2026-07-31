import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runPipeline } from '../src/pipeline.js';
import { SecurityViolationError } from '../src/errors.js';
import { makeTmpRepo } from './helpers/tmprepo.js';

const SHIM = resolve('tests/fixtures/fake-claude.mjs');
const REVIEWER_IDS = ['alpha', 'bravo', 'charlie', 'delta'] as const;

function setupFanOutDir(root: string, maxParallel: number) {
  const rd = join(root, '.review');
  mkdirSync(join(rd, 'rules', 'shared'), { recursive: true });
  mkdirSync(join(rd, 'reviewers'), { recursive: true });
  writeFileSync(join(rd, 'config.yaml'), [
    'schema_version: 1',
    'aggregation:',
    `  max_parallel: ${maxParallel}`,
    'reviewers:',
    ...REVIEWER_IDS.flatMap((id) => [
      `  - id: ${id}`,
      '    tier: 2',
      '    rules: rules/shared/**',
      '    min_confidence_to_block: 0.7',
    ]),
  ].join('\n'));
  writeFileSync(join(rd, 'rules', 'shared', 'SEC-001.md'),
    '---\nid: SEC-001\ntitle: No eval\ndomain: security\nseverity: high\nblocking: true\nstatus: active\n---\n\nNever eval user input.\n');
  for (const id of REVIEWER_IDS) {
    writeFileSync(join(rd, 'reviewers', `${id}.md`),
      `---\nid: ${id}\n---\n\nYou review changes for ${id} only.\n`);
  }
}

function env(mode: string, extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH!, HOME: process.env.HOME!,
    REVU_CLAUDE_BIN: SHIM, REVU_CONFIG_HOME: '/nonexistent-global',
    FAKE_CLAUDE_MODE: mode, ...extra,
  };
}

/** Sweep-line over "start,<id>,<ts>" / "end,<id>,<ts>" lines: max simultaneous in-flight. */
function maxOverlap(markerFile: string): number {
  const lines = readFileSync(markerFile, 'utf8').trim().split('\n').filter(Boolean);
  const events = lines.map((line) => {
    const [kind, , tsRaw] = line.split(',');
    return { kind, ts: Number(tsRaw) };
  });
  events.sort((a, b) => a.ts - b.ts || (a.kind === 'end' ? -1 : 1));
  let current = 0;
  let max = 0;
  for (const e of events) {
    current += e.kind === 'start' ? 1 : -1;
    max = Math.max(max, current);
  }
  return max;
}

function startedIds(markerFile: string): string[] {
  if (!existsSync(markerFile)) return [];
  return readFileSync(markerFile, 'utf8').trim().split('\n').filter(Boolean)
    .filter((line) => line.startsWith('start,'))
    .map((line) => line.split(',')[1]!);
}

let repo: ReturnType<typeof makeTmpRepo>;
let scratchDir: string;
let markerFile: string;

beforeEach(() => {
  repo = makeTmpRepo();
  repo.commit('src/a.ts', 'const x = 1;\n', 'base');
  // Markers must live OUTSIDE the repo: writing inside it would itself be a
  // working-tree mutation and trip the very git-state guard under test.
  scratchDir = mkdtempSync(join(tmpdir(), 'revu-markers-'));
  markerFile = join(scratchDir, 'markers.log');
});
afterEach(() => { repo.cleanup(); rmSync(scratchDir, { recursive: true, force: true }); });

describe('runPipeline parallel fan-out', () => {
  it('runs reviewers concurrently without exceeding aggregation.max_parallel', async () => {
    setupFanOutDir(repo.root, 2);
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 2;\n', 'benign change');

    const { envelope } = await runPipeline(repo.root, {}, env('jitter', { FAKE_MARKER_FILE: markerFile }));

    expect(envelope.status).toBe('PASS');
    expect(startedIds(markerFile).sort()).toEqual([...REVIEWER_IDS].sort());
    expect(maxOverlap(markerFile)).toBeGreaterThan(1); // proves it's actually parallel
    expect(maxOverlap(markerFile)).toBeLessThanOrEqual(2); // proves the bound is respected
  });

  it('collects reports in config order regardless of completion jitter', async () => {
    setupFanOutDir(repo.root, 4);
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 3;\n', 'benign change');

    const { envelope } = await runPipeline(repo.root, {}, env('jitter', { FAKE_MARKER_FILE: markerFile }));

    expect(envelope.reviews.map((r) => r.reviewer)).toEqual([...REVIEWER_IDS]);
  });

  it('aborts with SecurityViolationError when any reviewer mutates the repo, ' +
    'discarding in-flight results and starting no further reviewers', async () => {
    setupFanOutDir(repo.root, 2);
    repo.commitAll('add review config');
    repo.branch('feature');
    repo.commit('src/a.ts', 'const x = 4;\n', 'benign change');

    await expect(runPipeline(repo.root, {}, env('mutate-one', {
      FAKE_MARKER_FILE: markerFile,
      FAKE_MUTATE_REVIEWER_ID: 'alpha',
      FAKE_MUTATE_PATH: join(repo.root, 'evil.ts'),
    }))).rejects.toThrow(SecurityViolationError);

    // alpha (mutator) and bravo (its concurrent lane partner) started; charlie/delta never did.
    const started = startedIds(markerFile);
    expect(started).toContain('alpha');
    expect(started).not.toContain('charlie');
    expect(started).not.toContain('delta');
  });
});
