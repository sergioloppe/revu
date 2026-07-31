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
  /** The changed paths themselves. Shown so "2 file(s)" is never the only clue. */
  paths?: string[];
}

export interface PlanInfo {
  reviewers: string[];
  /** Reviewer ids that were configured but had no applicable rules for this diff. */
  skipped: string[];
  maxParallel: number;
  rules: number;
  /**
   * Set only when no catalog rule matched the diff: the changed paths, and every
   * `applies_to` glob the effective catalog declares. Present so the run can say
   * which files went unmatched and what the catalog does cover, instead of leaving
   * a green result with no explanation.
   */
  coverage?: { paths: string[]; globs: string[] };
}

export interface Reporter {
  runStart(version: string, repoRoot: string): void;
  diff(info: DiffInfo): void;
  /** Changed paths withheld from the review because they hold secrets. */
  excluded(paths: string[]): void;
  /** A tier the caller asked to skip, and what that skipped. */
  tierSkipped(tier: number, what: string): void;
  tier0Start(count: number): void;
  tier0Check(outcome: { id: string; status: string; blocking?: boolean; duration_ms: number }): void;
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

/**
 * Joins a list, capping it so a 300-file diff doesn't bury the message it belongs to.
 * The count comes first in the overflow so the total is never lost to truncation.
 */
function listBriefly(items: string[], max = 8): string {
  if (items.length === 0) return '(none)';
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} … and ${items.length - max} more`;
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
    diff({ mode, base, head, files, paths }) {
      const range = base === head ? short(head) : `${short(base)}..${short(head)}`;
      // Not indented under the run header: tier-0 output lands between the two.
      write(`reviewing ${mode} ${dim(`· ${range} · ${files} file(s)`)}`);
      // Naming the paths is what makes an unexpected result self-explanatory — a diff
      // of the two files you didn't mean to review looks identical to the right one
      // when all you print is a count.
      if (paths?.length) write(dim(`  ${listBriefly(paths)}`));
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
    tier0Check({ id, status, blocking, duration_ms }) {
      // '!' rather than '✗' for an advisory failure: live output is where a user decides
      // whether the run is dead, and a ✗ that doesn't stop anything trains them to ignore ✗.
      const mark = status === 'PASS' ? '✓' : blocking === false ? '!' : '✗';
      const note = status !== 'PASS' && blocking === false ? ' (non-blocking)' : '';
      write(`  ${mark} ${id}${note} ${dim(`(${secs(duration_ms)})`)}`);
    },
    plan({ reviewers, skipped, maxParallel, rules, coverage }) {
      if (reviewers.length === 0 && coverage) {
        // The diagnosable form: which paths went unmatched, and what the catalog covers.
        write('no reviewers to run — no catalog rule matched these paths:');
        write(dim(`  ${listBriefly(coverage.paths)}`));
        write(dim(`  this catalog covers: ${listBriefly(coverage.globs)}`));
        write(dim('  (revu doctor reports catalog/repo coverage in full)'));
      } else if (reviewers.length === 0) {
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
