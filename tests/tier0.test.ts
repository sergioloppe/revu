import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTier0, blockingFailures, advisoryFailures } from '../src/tier0.js';

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

  it('runs every check even after one fails, so a run reports the whole picture', async () => {
    const result = await runTier0(
      [{ id: 'a', command: 'exit 1' }, { id: 'b', command: 'exit 0' }],
      dir, 5,
    );
    expect(result.status).toBe('FAIL');
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0]).toMatchObject({ id: 'a', status: 'FAIL' });
    expect(result.checks[1]).toMatchObject({ id: 'b', status: 'PASS' });
  });

  it('treats a check with no explicit blocking as gating (fail closed)', async () => {
    const result = await runTier0([{ id: 'a', command: 'exit 1' }], dir, 5);
    expect(result.status).toBe('FAIL');
    expect(result.checks[0]!.blocking).toBe(true);
    expect(blockingFailures(result).map((c) => c.id)).toEqual(['a']);
    expect(advisoryFailures(result)).toEqual([]);
  });

  it('a failing non-blocking check does not fail the run', async () => {
    const result = await runTier0(
      [{ id: 'hygiene', command: 'exit 1', blocking: false }], dir, 5,
    );
    expect(result.status).toBe('PASS');
    expect(result.checks[0]).toMatchObject({ id: 'hygiene', status: 'FAIL', blocking: false });
    expect(advisoryFailures(result).map((c) => c.id)).toEqual(['hygiene']);
    expect(blockingFailures(result)).toEqual([]);
  });

  it('one blocking failure fails the run even amid passing and advisory checks', async () => {
    const result = await runTier0([
      { id: 'hygiene', command: 'exit 1', blocking: false },
      { id: 'ok', command: 'exit 0' },
      { id: 'build', command: 'exit 1', blocking: true },
    ], dir, 5);
    expect(result.status).toBe('FAIL');
    expect(blockingFailures(result).map((c) => c.id)).toEqual(['build']);
    expect(advisoryFailures(result).map((c) => c.id)).toEqual(['hygiene']);
  });

  it('a timed-out non-blocking check is advisory too', async () => {
    const result = await runTier0(
      [{ id: 'slow', command: 'sleep 5', blocking: false }], dir, 0.2,
    );
    expect(result.status).toBe('PASS');
    expect(result.checks[0]).toMatchObject({ id: 'slow', status: 'TIMEOUT', blocking: false });
    expect(advisoryFailures(result).map((c) => c.id)).toEqual(['slow']);
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
