import { spawn } from 'node:child_process';
import type { Tier0Check } from './config/schema.js';

export interface Tier0CheckOutcome {
  id: string;
  status: 'PASS' | 'FAIL' | 'TIMEOUT';
  /** Whether failing this check gates the run. Carried through so every consumer
   * (envelope, renderer, progress) can tell a gate from a note without re-reading config. */
  blocking: boolean;
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
  /** FAIL iff a *blocking* check failed. Advisory failures leave this PASS. */
  status: 'PASS' | 'FAIL';
  checks: Tier0CheckOutcome[];
}

/** Checks that did not pass and gate the run. Non-empty means exit 4, no reviewers. */
export function blockingFailures(result: Tier0RunResult): Tier0CheckOutcome[] {
  return result.checks.filter((c) => c.status !== 'PASS' && c.blocking);
}

/** Checks that did not pass but only report. Non-empty is surfaced, never fatal. */
export function advisoryFailures(result: Tier0RunResult): Tier0CheckOutcome[] {
  return result.checks.filter((c) => c.status !== 'PASS' && !c.blocking);
}

/**
 * Resolves a check's gating, defaulting to blocking when the field is absent.
 *
 * The zod schema already defaults it to true, but that only applies to configs that
 * went through a parse — a Tier0Check built directly (a library caller, a test) has
 * `blocking: undefined`, and reading that field raw would silently treat it as
 * advisory. Defaulting here rather than at the field makes the failure mode
 * fail-closed: an unspecified check gates, and no config can lose its gate by
 * accident.
 */
function isBlocking(check: Tier0Check): boolean {
  return check.blocking ?? true;
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
        blocking: isBlocking(check),
        duration_ms: Date.now() - started,
        output,
        command: check.command,
        exit_code: code,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({
        id: check.id, status: 'FAIL', blocking: isBlocking(check), duration_ms: Date.now() - started,
        output: output + String(err),
        command: check.command, exit_code: null,
      });
    });
  });
}

/**
 * Runs every tier-0 check sequentially. Deliberately NOT fail-fast: an earlier
 * version stopped at the first non-PASS, so a repo with a failing hygiene check
 * never learned whether its build or tests passed either — you fixed one thing,
 * re-ran, and met the next. Checks are deterministic and comparatively cheap, so
 * one run reports the complete picture.
 *
 * `status` reflects blocking checks only. An advisory check that fails is recorded
 * in `checks` for the caller to surface, but does not fail the run.
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
  }
  const result: Tier0RunResult = { status: 'PASS', checks: outcomes };
  return blockingFailures(result).length ? { ...result, status: 'FAIL' } : result;
}
