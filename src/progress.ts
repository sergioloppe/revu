/**
 * Run progress, written to stderr.
 *
 * stderr (not stdout) on purpose: `revu --format json` and any non-TTY invocation
 * put the envelope on stdout, so progress must not land in a pipe someone is
 * parsing. Reviewers routinely take minutes with nothing to say in the meantime,
 * so the reporter also emits a periodic heartbeat naming what is still in flight.
 */

const ESC = String.fromCharCode(27) + '[';
const HEARTBEAT_MS = 20_000;

export interface DiffInfo {
  mode: string;
  base: string;
  head: string;
  files: number;
}

export interface PlanInfo {
  reviewers: string[];
  /** Reviewer ids that were configured but had no applicable rules for this diff. */
  skipped: string[];
  maxParallel: number;
  rules: number;
}

export interface Reporter {
  runStart(version: string, repoRoot: string): void;
  diff(info: DiffInfo): void;
  /** Changed paths withheld from the review because they hold secrets. */
  excluded(paths: string[]): void;
  /** A tier the caller asked to skip, and what that skipped. */
  tierSkipped(tier: number, what: string): void;
  tier0Start(count: number): void;
  tier0Check(outcome: { id: string; status: string; duration_ms: number }): void;
  plan(info: PlanInfo): void;
  reviewerStart(id: string, model: string, rules: number): void;
  reviewerDone(id: string, status: string, ms: number, cached: boolean): void;
  /** Stops the heartbeat. Safe to call more than once. */
  done(): void;
}

/** No-op reporter: the default for library callers and tests. */
export const silentReporter: Reporter = {
  runStart() {}, diff() {}, excluded() {}, tierSkipped() {}, tier0Start() {}, tier0Check() {}, plan() {},
  reviewerStart() {}, reviewerDone() {}, done() {},
};

function short(sha: string): string {
  return /^[0-9a-f]{7,}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

function secs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export interface ReporterOpts {
  /** Emit ANSI dim/bold. Defaults to whether stderr is a TTY. */
  color?: boolean;
  /** Emit the periodic in-flight heartbeat. Defaults to whether stderr is a TTY. */
  heartbeat?: boolean;
  /** Heartbeat period. Exposed for tests. */
  intervalMs?: number;
  write?: (line: string) => void;
}

export function createReporter(opts: ReporterOpts = {}): Reporter {
  const isTty = Boolean(process.stderr.isTTY);
  const color = opts.color ?? isTty;
  const heartbeat = opts.heartbeat ?? isTty;
  const write = opts.write ?? ((line: string) => process.stderr.write(`${line}\n`));

  const dim = (s: string) => (color ? `${ESC}2m${s}${ESC}0m` : s);
  const bold = (s: string) => (color ? `${ESC}1m${s}${ESC}0m` : s);

  const started = Date.now();
  const inFlight = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;

  function stopHeartbeat() {
    if (timer) { clearInterval(timer); timer = null; }
  }
  function startHeartbeat() {
    if (!heartbeat || timer) return;
    timer = setInterval(() => {
      if (inFlight.size === 0) return;
      const names = [...inFlight.keys()].join(', ');
      write(dim(`  … still running: ${names} (${secs(Date.now() - started)} elapsed)`));
    }, opts.intervalMs ?? HEARTBEAT_MS);
    // Never hold the event loop open on the heartbeat alone.
    timer.unref?.();
  }

  return {
    runStart(version, repoRoot) {
      write(`${bold(`revu ${version}`)} ${dim(repoRoot)}`);
    },
    diff({ mode, base, head, files }) {
      const range = base === head ? short(head) : `${short(base)}..${short(head)}`;
      // Not indented under the run header: tier-0 output lands between the two.
      write(`reviewing ${mode} ${dim(`· ${range} · ${files} file(s)`)}`);
    },
    excluded(paths) {
      if (paths.length === 0) return;
      // Named, never silent: "revu didn't flag my .env" must have a visible reason.
      write(dim(`  withheld (secret-bearing or revu-generated): ${paths.join(', ')}`));
    },
    tierSkipped(tier, what) {
      // Never dim: skipping tier 0 removes the gate that stops a broken repo before
      // any spend, so the run must say so plainly rather than look like a normal one.
      write(`tier ${tier}: SKIPPED (${what})`);
    },
    tier0Start(count) {
      write(`tier 0: running ${count} check(s)`);
    },
    tier0Check({ id, status, duration_ms }) {
      const mark = status === 'PASS' ? '✓' : '✗';
      write(`  ${mark} ${id} ${dim(`(${secs(duration_ms)})`)}`);
    },
    plan({ reviewers, skipped, maxParallel, rules }) {
      if (reviewers.length === 0) {
        write('no reviewers to run (no configured reviewer matched an applicable rule)');
      } else {
        write(`reviewers: ${reviewers.length} to run, ${rules} applicable rule(s), ` +
          `up to ${maxParallel} in parallel`);
      }
      if (skipped.length > 0) {
        write(dim(`  skipped (no applicable rules): ${skipped.join(', ')}`));
      }
      startHeartbeat();
    },
    reviewerStart(id, model, rules) {
      inFlight.set(id, Date.now());
      write(dim(`  → ${id} started (${model}, ${rules} rule(s))`));
    },
    reviewerDone(id, status, ms, cached) {
      inFlight.delete(id);
      const mark = status === 'PASS' ? '✓' : status === 'NEEDS_HUMAN_REVIEW' ? '?' : '✗';
      const how = cached ? 'cached' : secs(ms);
      write(`  ${mark} ${id} ${status} ${dim(`(${how})`)}`);
    },
    done() {
      stopHeartbeat();
      inFlight.clear();
    },
  };
}
