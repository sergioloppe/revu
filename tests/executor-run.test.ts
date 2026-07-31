import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runReviewer, resolveClaudeBin } from '../src/executor/run.js';
import { validateReviewerOutput } from '../src/report/validate.js';

const SHIM = resolve('tests/fixtures/fake-claude.mjs');
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'revu-exec-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'const x = 1;\neval(input);\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const opts = (mode: string, extraEnv: Record<string, string> = {}) => ({
  reviewerId: 'security', model: 'claude-opus-4-8', prompt: 'Review this diff.',
  timeoutSeconds: 5, repoRoot: root, claudeBin: SHIM,
  env: { PATH: process.env.PATH!, HOME: process.env.HOME!, FAKE_CLAUDE_MODE: mode, ...extraEnv },
  validate: (stdout: string) => validateReviewerOutput(stdout, {
    reviewerId: 'security', diffFiles: ['src/a.ts'], ruleIds: new Set(['SEC-001']), repoRoot: root,
  }),
});

describe('runReviewer', () => {
  it('returns a validated FAIL report with cost', async () => {
    const out = await runReviewer(opts('fail'));
    expect(out.report.status).toBe('FAIL');
    expect(out.report.issues[0]!.rule).toBe('SEC-001');
    expect(out.costUsd).toBe(0.05);
    expect(out.retried).toBe(false);
  });

  it('retries once on malformed output, appending the validation error', async () => {
    const stateFile = join(root, 'state');
    const out = await runReviewer(opts('malformed-once', { FAKE_STATE_FILE: stateFile }));
    expect(out.retried).toBe(true);
    expect(out.report.status).toBe('FAIL');
  });

  it('escalates to NEEDS_HUMAN_REVIEW after a second malformed response', async () => {
    const out = await runReviewer(opts('malformed-always'));
    expect(out.report.status).toBe('NEEDS_HUMAN_REVIEW');
    expect(out.report.debug).toContain('prose');
  });

  it('escalates to NEEDS_HUMAN_REVIEW on timeout', async () => {
    const out = await runReviewer({ ...opts('slow'), timeoutSeconds: 1 });
    expect(out.report.status).toBe('NEEDS_HUMAN_REVIEW');
    expect(out.report.summary).toMatch(/timed out/i);
  }, 10_000);

  it('does not crash on EPIPE when the child exits before a large prompt drains', async () => {
    const largePrompt = 'x'.repeat(4 * 1024 * 1024);
    const out = await runReviewer({ ...opts('exit-early'), prompt: largePrompt });
    expect(out.report.status).toBe('NEEDS_HUMAN_REVIEW');
  }, 10_000);

  it('captures reviewer stderr into debug on a crash', async () => {
    const out = await runReviewer(opts('crash'));
    expect(out.report.status).toBe('NEEDS_HUMAN_REVIEW');
    expect(out.report.debug).toContain('boom');
  });

  it('resolves the claude binary from REVU_CLAUDE_BIN', () => {
    expect(resolveClaudeBin({ REVU_CLAUDE_BIN: '/x/claude' })).toBe('/x/claude');
    expect(resolveClaudeBin({})).toBe('claude');
  });

  it('cleans up isolated settings directory after execution', async () => {
    // Isolate this test's tmpdir so parallel test files creating/removing their
    // own revu-settings-* dirs cannot race the count assertion.
    const isolatedTmp = mkdtempSync(join(tmpdir(), 'revu-cleanup-probe-'));
    const prevTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = isolatedTmp;
    try {
      await runReviewer(opts('pass'));
      const leftovers = readdirSync(isolatedTmp).filter(f => f.startsWith('revu-settings-'));
      expect(leftovers).toEqual([]);
    } finally {
      if (prevTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmpdir;
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  });
});

describe('isolation settings', () => {
  it('denies the read tools on credential files', async () => {
    const dump = join(root, 'settings-dump.json');
    await runReviewer(opts('pass', { FAKE_SETTINGS_DUMP: dump }));
    const settings = JSON.parse(readFileSync(dump, 'utf8'));

    expect(settings.mcpServers).toEqual({});
    expect(settings.disableAllHooks).toBe(true);
    // Diff-level exclusion is the guarantee; this is the "reviewer went looking" gap.
    for (const pattern of ['Read(**/.env)', 'Read(**/.env.*)', 'Grep(**/.env.*)', 'Read(**/*.pem)']) {
      expect(settings.permissions.deny).toContain(pattern);
    }
  });
});
