import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTier0 } from '../src/tier0.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'revu-tier0-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('runTier0', () => {
  it('PASSes when every check exits 0', async () => {
    const result = await runTier0(
      [{ id: 'a', command: 'exit 0' }, { id: 'b', command: 'exit 0' }],
      dir, 5,
    );
    expect(result.status).toBe('PASS');
    expect(result.checks.map((c) => c.status)).toEqual(['PASS', 'PASS']);
  });

  it('fails fast: stops at the first non-zero exit and never runs later checks', async () => {
    const result = await runTier0(
      [{ id: 'a', command: 'exit 1' }, { id: 'b', command: 'exit 0' }],
      dir, 5,
    );
    expect(result.status).toBe('FAIL');
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ id: 'a', status: 'FAIL' });
  });

  it('captures combined stdout+stderr as output', async () => {
    const result = await runTier0(
      [{ id: 'a', command: 'echo out-line; echo err-line 1>&2; exit 1' }],
      dir, 5,
    );
    expect(result.checks[0]!.output).toContain('out-line');
    expect(result.checks[0]!.output).toContain('err-line');
  });

  it('marks a check TIMEOUT when it exceeds its own timeout_seconds', async () => {
    const result = await runTier0(
      [{ id: 'slow', command: 'sleep 3', timeout_seconds: 1 }],
      dir, 5,
    );
    expect(result.status).toBe('FAIL');
    expect(result.checks[0]).toMatchObject({ id: 'slow', status: 'TIMEOUT' });
  });

  it('falls back to the pipeline default timeout when a check omits timeout_seconds', async () => {
    const result = await runTier0([{ id: 'slow', command: 'sleep 3' }], dir, 1);
    expect(result.checks[0]).toMatchObject({ id: 'slow', status: 'TIMEOUT' });
  });

  it('reports duration_ms for each check', async () => {
    const result = await runTier0([{ id: 'a', command: 'exit 0' }], dir, 5);
    expect(result.checks[0]!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('runs with an empty checks list as a trivial PASS', async () => {
    const result = await runTier0([], dir, 5);
    expect(result).toEqual({ status: 'PASS', checks: [] });
  });
});

describe('failing check diagnostics', () => {
  it('records the command and exit code alongside the outcome', async () => {
    const result = await runTier0([{ id: 'silent', command: 'exit 7' }], process.cwd(), 10);
    expect(result.status).toBe('FAIL');
    const check = result.checks[0]!;
    expect(check.command).toBe('exit 7');
    expect(check.exit_code).toBe(7);
    expect(check.output).toBe('');
  });

  // The reported case: `test -z "$(...)"` swallows its own output, so the outcome
  // carries nothing a user could act on except the command itself.
  it('keeps the command for a check that fails with no output at all', async () => {
    const cmd = 'test -z "$(printf \'a.go\\nb.go\\n\')"';
    const result = await runTier0([{ id: 'fmt', command: cmd }], process.cwd(), 10);
    expect(result.status).toBe('FAIL');
    expect(result.checks[0]!.output.trim()).toBe('');
    expect(result.checks[0]!.command).toBe(cmd);
  });
});
