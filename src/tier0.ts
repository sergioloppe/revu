import { spawn } from 'node:child_process';
import type { Tier0Check } from './config/schema.js';

export interface Tier0CheckOutcome {
  id: string;
  status: 'PASS' | 'FAIL' | 'TIMEOUT';
  duration_ms: number;
  /** Combined stdout+stderr, for surfacing to the user on failure. Not part of the envelope. */
  output: string;
  /**
   * The shell command that ran, and how it exited. Kept because a failing check is
   * not required to explain itself: the common `test -z "$(gofmt -l ...)"` idiom
   * swallows its output into the substitution and fails completely silently, leaving
   * "check failed" with nothing to act on. Reporting the command makes any check
   * reproducible by hand. Not part of the envelope.
   */
  command: string;
  exit_code: number | null;
}

export interface Tier0RunResult {
  status: 'PASS' | 'FAIL';
  checks: Tier0CheckOutcome[];
}

function runCheck(check: Tier0Check, repoRoot: string, defaultTimeoutSeconds: number): Promise<Tier0CheckOutcome> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const timeoutMs = (check.timeout_seconds ?? defaultTimeoutSeconds) * 1000;
    let output = '';
    let timedOut = false;
    // `detached: true` makes the child (the shell running `command`) the leader of its
    // own process group. On timeout we kill that whole group (negative pid) instead of
    // just the shell, so grandchildren the shell spawned (e.g. `long-running-tool &`, a
    // pipeline, a `make` sub-invocation) are reaped too — killing only the shell leaves
    // them running as orphans past the timeout.
    const child = spawn(check.command, { cwd: repoRoot, shell: true, detached: true });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Process group kill can fail (e.g. group already gone, or unsupported
        // platform semantics) — fall back to killing just the direct child.
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        id: check.id,
        status: timedOut ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL',
        duration_ms: Date.now() - started,
        output,
        command: check.command,
        exit_code: code,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({
        id: check.id, status: 'FAIL', duration_ms: Date.now() - started,
        output: output + String(err),
        command: check.command, exit_code: null,
      });
    });
  });
}

/**
 * Runs tier-0 checks sequentially, stopping at the first non-PASS result (fail-fast):
 * deterministic checks are cheap and ordered by the user, so there is no reason to
 * pay for later checks once an earlier one has already failed the run.
 */
export async function runTier0(
  checks: Tier0Check[],
  repoRoot: string,
  defaultTimeoutSeconds: number,
  onCheck?: (outcome: Tier0CheckOutcome) => void,
): Promise<Tier0RunResult> {
  const outcomes: Tier0CheckOutcome[] = [];
  for (const check of checks) {
    const outcome = await runCheck(check, repoRoot, defaultTimeoutSeconds);
    outcomes.push(outcome);
    onCheck?.(outcome);
    if (outcome.status !== 'PASS') return { status: 'FAIL', checks: outcomes };
  }
  return { status: 'PASS', checks: outcomes };
}
