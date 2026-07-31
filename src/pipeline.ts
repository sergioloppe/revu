import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { loadEffectiveConfig } from './config/cascade.js';
import { findRepoRoot, git } from './gitio/repo.js';
import { computeDiff } from './gitio/diff.js';
import { loadRules, filterRules } from './catalog/rules.js';
import { loadReviewerPersona } from './catalog/reviewers.js';
import { compilePrompt } from './compiler/compile.js';
import { preflight, detectAuthMode } from './executor/preflight.js';
import { resolveClaudeBin, runReviewer } from './executor/run.js';
import { snapshotGitState, verifyGitState } from './executor/gitstate.js';
import { validateReviewerOutput } from './report/validate.js';
import { aggregate } from './aggregate/aggregate.js';
import { buildEnvelope, type AggregateEnvelope, type Tier0Envelope } from './report/envelope.js';
import { runPool } from './util/pool.js';
import {
  advisoryFailures, blockingFailures, runTier0,
  type Tier0CheckOutcome, type Tier0RunResult,
} from './tier0.js';
import { cacheKey, readCache, writeCache } from './cache.js';
import { readBaseline, readDismissals, suppressFindings } from './suppress.js';
import { resolveSkillsForReviewer } from './skills.js';
import { silentReporter, type Reporter } from './progress.js';
import { EXIT, REVU_VERSION } from './constants.js';
import type { ReviewerReport } from './report/schema.js';
import type { ReviewerConfig } from './config/schema.js';
import type { Rule } from './catalog/rules.js';
import type { RunOutcome } from './executor/run.js';

export interface PipelineOpts {
  staged?: boolean; working?: boolean; range?: string; files?: string[];
  /** Run exactly these reviewer ids, regardless of tier. */
  only?: string[];
  /** Exclude these reviewer ids. */
  skip?: string[];
  /** Run reviewers at or below this tier (default: all). 0 runs tier-0 checks only. */
  tier?: 0 | 1 | 2;
  /**
   * Tiers to skip entirely. Skipping 0 bypasses the deterministic checks — the gate
   * that normally stops a run before any spend — so it is recorded on the envelope
   * rather than silently applied.
   */
  skipTiers?: Array<0 | 1 | 2>;
  /** Read from the review cache. Writes always happen regardless. Default: true. */
  cache?: boolean;
  /**
   * Run the baseline/dismissals suppression pass before aggregation. Default: true.
   * `revu --baseline` sets this to false so the baseline it records reflects every
   * finding reviewers produced this run, not the subset an existing baseline or
   * dismissal already hides.
   */
  suppress?: boolean;
  /** Progress sink. Defaults to silent, so library callers and tests print nothing. */
  reporter?: Reporter;
}

/**
 * Appends a note naming the non-gating tier-0 checks that failed.
 *
 * A run whose only red is advisory still exits 0 — that is what non-blocking means —
 * so the reason string is the one place a reader is guaranteed to see it. Silence
 * here would make "PASS" indistinguishable from a run where everything was green.
 */
function withAdvisoryNote(reason: string, advisory: Tier0CheckOutcome[]): string {
  if (advisory.length === 0) return reason;
  return `${reason} (${advisory.length} non-blocking tier-0 check(s) failed: ` +
    `${advisory.map((c) => c.id).join(', ')})`;
}

/** Envelope's typed check summary, stripped of the raw stdout/stderr `output`. */
function toEnvelopeTier0(result: Tier0RunResult): Tier0Envelope {
  return {
    status: result.status,
    checks: result.checks.map(({ id, status, blocking, duration_ms }) =>
      ({ id, status, blocking, duration_ms })),
  };
}

export async function runPipeline(
  cwd: string,
  opts: PipelineOpts,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ envelope: AggregateEnvelope; exitCode: number }> {
  const started = Date.now();
  const repoRoot = findRepoRoot(cwd);
  const reporter = opts.reporter ?? silentReporter;
  reporter.runStart(REVU_VERSION, repoRoot);
  const loaded = loadEffectiveConfig(repoRoot, env);

  // The diff is resolved before anything else runs. It is pure git — no subprocess
  // spend, no `claude` on PATH — and an empty one means there is nothing for the rest
  // of the pipeline to act on. Resolving it first is what makes "nothing to review"
  // cost nothing: tier 0 does not run, so a repo whose formatter takes 98s and whose
  // test suite is red does not pay either price to be told its diff was empty.
  // computeDiff throws a ToolError carrying the full "here is what your tree actually
  // holds, try one of these" message.
  const diff = computeDiff(repoRoot, opts);

  // Tier 0: deterministic checks (lint, typecheck, ...) run first, before any Claude
  // spend — no preflight, no diff computation, no reviewer selection. A failure short
  // -circuits the whole run with exit 4. Uses detectAuthMode (no subprocess) rather
  // than preflight() so a failing tier-0 check never even requires `claude` on PATH.
  const skipTiers = new Set<number>(opts.skipTiers ?? []);
  const tier0Checks = loaded.config.tiers['0']?.checks ?? [];
  let tier0Result: Tier0RunResult | null = null;
  /** Non-gating checks that failed. Folded into the final decision_reason so a PASS
   * never hides the fact that a check went red. */
  let tier0Advisory: Tier0CheckOutcome[] = [];
  if (tier0Checks.length > 0 && skipTiers.has(0)) {
    reporter.tierSkipped(0, `${tier0Checks.length} deterministic check(s)`);
  } else if (tier0Checks.length > 0) {
    reporter.tier0Start(tier0Checks.length);
    tier0Result = await runTier0(tier0Checks, repoRoot, loaded.config.defaults.timeout_seconds,
      (outcome) => reporter.tier0Check(outcome));
    // Every failure gets reported, blocking or not. The raw command output isn't part
    // of the (structured) envelope; surface it here. A check is under no obligation to
    // explain itself — `test -z "$(gofmt -l ...)"` fails with entirely empty output —
    // so always print the command that ran, and say plainly when there was no output
    // rather than trailing off into a blank line.
    const describeFailure = (check: Tier0CheckOutcome): string => {
      const detail = check.output.trim()
        ? `\n${check.output.trimEnd()}`
        : '\n  (the command produced no output — run it yourself to see why it failed)';
      const how = check.status === 'TIMEOUT'
        ? `timed out after ${Math.round(check.duration_ms / 1000)}s`
        : `exited ${check.exit_code}`;
      return `revu: tier 0 check "${check.id}" ${check.status} (${how})\n` +
        `  command: ${check.command}${detail}`;
    };
    const blocking = blockingFailures(tier0Result);
    tier0Advisory = advisoryFailures(tier0Result);
    for (const check of [...blocking, ...tier0Advisory]) {
      console.error(check.blocking
        ? describeFailure(check)
        : `${describeFailure(check)}\n  (non-blocking — reported, but the review continues)`);
    }

    if (blocking.length > 0) {
      const head = git(repoRoot, ['rev-parse', 'HEAD']);
      const reason = blocking.length === 1
        ? `tier 0 check ${blocking[0]!.id} failed`
        : `tier 0 checks failed: ${blocking.map((c) => c.id).join(', ')}`;
      const envelope = buildEnvelope({
        repoRoot, commit: head, base: head,
        config: loaded.config, layers: loaded.layers, authMode: detectAuthMode(env),
        rules: [], reports: [],
        result: { status: 'FAIL', decision_reason: reason, exitCode: EXIT.TIER0, demoted: [] },
        costUsd: null, durationMs: Date.now() - started,
        tier0: toEnvelopeTier0(tier0Result), skippedTiers: [...skipTiers],
      });
      return { envelope, exitCode: EXIT.TIER0 };
    }
  }
  if (opts.tier === 0) {
    // `--tier 0`: run tier-0 checks only, no reviewers — regardless of --only/--skip.
    const head = git(repoRoot, ['rev-parse', 'HEAD']);
    const envelope = buildEnvelope({
      repoRoot, commit: head, base: head,
      config: loaded.config, layers: loaded.layers, authMode: detectAuthMode(env),
      rules: [], reports: [],
      result: {
        status: 'PASS',
        // "checks passed" would contradict the note appended right after it.
        decision_reason: withAdvisoryNote(
          tier0Advisory.length ? 'tier 0 gating checks passed' : 'tier 0 checks passed',
          tier0Advisory),
        exitCode: EXIT.PASS, demoted: [],
      },
      costUsd: null, durationMs: Date.now() - started,
      tier0: tier0Result ? toEnvelopeTier0(tier0Result) : null,
      skippedTiers: [...skipTiers],
    });
    return { envelope, exitCode: EXIT.PASS };
  }

  // Preflight stays *after* tier 0 so a failing deterministic check never requires
  // `claude` to be installed at all.
  const claudeBin = resolveClaudeBin(env);
  const { authMode } = preflight(claudeBin, env);
  reporter.diff({
    mode: diff.mode, base: diff.base, head: diff.head,
    files: diff.files.length, paths: diff.files,
  });
  reporter.excluded(diff.excluded);

  const ruleSources = [
    ...(loaded.globalDir ? [{ dir: join(loaded.globalDir, 'rules'), origin: 'global' as const }] : []),
    ...(loaded.reviewDir ? [{ dir: join(loaded.reviewDir, 'rules'), origin: 'repo' as const }] : []),
  ];
  const personaSources = [
    ...(loaded.globalDir ? [{ dir: loaded.globalDir }] : []),
    ...(loaded.reviewDir ? [{ dir: loaded.reviewDir }] : []),
  ];
  const allRules = loadRules(ruleSources);
  const applicable = filterRules(allRules, diff.files);
  const rulesById = new Map(applicable.map((r) => [r.id, r]));
  // When nothing applies, the run ends in a PASS that reviewed nothing. Naming the
  // paths and what the catalog actually covers turns that from a mystery into a
  // one-line answer — without it the user sees only "2 file(s)" and a green result.
  const coverage = applicable.length === 0
    ? { paths: diff.files, globs: [...new Set(allRules.flatMap((r) => r.applies_to))].sort() }
    : undefined;

  const reports: ReviewerReport[] = [];
  let costTotal: number | null = null;

  const maxTier = opts.tier ?? 2;
  const only = opts.only;
  let selected = loaded.config.reviewers.filter((r) =>
    only && only.length ? only.includes(r.id) : r.tier <= maxTier);
  if (opts.skip && opts.skip.length) selected = selected.filter((r) => !opts.skip!.includes(r.id));
  // Applied after selection, so it also constrains --only: a reviewer named explicitly
  // on a skipped tier still doesn't run, matching how --skip behaves.
  if (skipTiers.size) {
    const droppedByTier = selected.filter((r) => skipTiers.has(r.tier));
    selected = selected.filter((r) => !skipTiers.has(r.tier));
    for (const tier of [1, 2]) {
      if (!skipTiers.has(tier)) continue;
      const dropped = droppedByTier.filter((r) => r.tier === tier).map((r) => r.id);
      if (dropped.length) reporter.tierSkipped(tier, dropped.join(', '));
    }
  }
  // Tier 1 (blocking) always runs before tier 2 (advisory), regardless of config declaration order.
  // This is a stable sort, so within a tier declaration order (== report order) is preserved.
  const ordered = [...selected].sort((a, b) => a.tier - b.tier);

  interface Job { reviewerCfg: ReviewerConfig; reviewerRules: Rule[]; prompt: string }
  const jobs: Job[] = [];
  // Skill content actually injected this run, in job order — folded into the
  // envelope's config_hash below so drift in a machine-local skill file is visible
  // (design §5.3), without requiring the skill to be vendored into the repo.
  const skillContentsForHash: string[] = [];
  const skippedReviewers: string[] = [];
  for (const reviewerCfg of ordered) {
    const matches = picomatch(reviewerCfg.rules);
    const reviewerRules = applicable.filter((r) => matches(`rules/${r.relPath}`));
    if (reviewerRules.length === 0) { // nothing applicable: spend nothing
      skippedReviewers.push(reviewerCfg.id);
      continue;
    }

    const persona = loadReviewerPersona(personaSources, reviewerCfg.id);
    const contextDocs = reviewerCfg.context.flatMap((rel) => {
      for (const { dir } of [...personaSources].reverse()) { // repo layer first
        const p = join(dir, rel);
        if (existsSync(p)) return [{ name: rel, content: readFileSync(p, 'utf8') }];
      }
      return []; // missing context docs are skipped
    });
    const skillDocs = resolveSkillsForReviewer(loaded.config.context.skills, reviewerCfg.id, env)
      .map((s) => ({ name: `skill:${s.source}/${s.name}`, content: s.content }));
    skillContentsForHash.push(...skillDocs.map((d) => d.content));
    const prompt = compilePrompt({
      reviewerId: reviewerCfg.id, persona: persona.body,
      rules: reviewerRules, contextDocs: [...contextDocs, ...skillDocs], diff: diff.patch,
    });
    jobs.push({ reviewerCfg, reviewerRules, prompt });
  }

  // Snapshot ONCE before the fan-out (not per-reviewer): per-reviewer snapshots don't
  // compose with concurrency, since a running reviewer would see other in-flight
  // reviewers' (legitimate, if any existed) state as "changes". Every reviewer's
  // post-run state is verified against this single baseline.
  reporter.plan({
    reviewers: jobs.map((j) => j.reviewerCfg.id),
    skipped: skippedReviewers,
    maxParallel: loaded.config.aggregation.max_parallel,
    rules: applicable.length,
    coverage,
  });

  const before = snapshotGitState(repoRoot);
  const cacheReadEnabled = opts.cache !== false;
  // Cache writes are deferred until after the whole pool settles (below), never made
  // from inside a worker: writing `.review/cache/**` mid-flight would itself change
  // `git status --porcelain` and trip a concurrently-running sibling's verifyGitState.
  const pendingWrites: Array<{ key: string; report: ReviewerReport; costUsd: number | null } | null> =
    new Array(jobs.length).fill(null);
  const outcomes = await runPool(jobs, loaded.config.aggregation.max_parallel, async (job, index): Promise<RunOutcome> => {
    const key = cacheKey(job.reviewerCfg.id, job.reviewerCfg.model, job.prompt);
    if (cacheReadEnabled) {
      const hit = readCache(repoRoot, key);
      if (hit) {
        reporter.reviewerDone(job.reviewerCfg.id, hit.report.status, 0, true);
        return { report: { ...hit.report, cached: true }, costUsd: hit.costUsd, retried: false };
      }
    }

    const reviewerStarted = Date.now();
    reporter.reviewerStart(job.reviewerCfg.id, job.reviewerCfg.model, job.reviewerRules.length);
    const outcome = await runReviewer({
      reviewerId: job.reviewerCfg.id, model: job.reviewerCfg.model, prompt: job.prompt,
      timeoutSeconds: loaded.config.defaults.timeout_seconds,
      repoRoot, claudeBin, env,
      validate: (stdout) => validateReviewerOutput(stdout, {
        reviewerId: job.reviewerCfg.id, diffFiles: diff.files,
        ruleIds: new Set(job.reviewerRules.map((r) => r.id)), repoRoot,
      }),
    });
    reporter.reviewerDone(job.reviewerCfg.id, outcome.report.status, Date.now() - reviewerStarted, false);
    verifyGitState(repoRoot, before, job.reviewerCfg.id); // throws SecurityViolationError
    // NEEDS_HUMAN_REVIEW reports are never cached: they reflect a transient execution
    // failure (timeout, crash, bad output), not a stable review result.
    if (outcome.report.status !== 'NEEDS_HUMAN_REVIEW') {
      pendingWrites[index] = { key, report: outcome.report, costUsd: outcome.costUsd };
    }
    return outcome;
  });
  for (const pending of pendingWrites) {
    if (pending) writeCache(repoRoot, pending.key, { report: pending.report, costUsd: pending.costUsd });
  }

  for (const outcome of outcomes) {
    reports.push(outcome.report);
    // A cache hit's costUsd is what that reviewer cost when it originally ran, replayed
    // from `.review/cache/reviews/**` — nothing was actually spent this run. Folding it
    // into costTotal would double-report cost every time the cache is hit. `cost.usd`
    // on the envelope is meant to reflect actual spend for *this* run only.
    if (!outcome.report.cached && outcome.costUsd !== null) costTotal = (costTotal ?? 0) + outcome.costUsd;
  }

  // Suppression pass (Task 5): baseline entries and active dismissals are removed
  // from what `aggregate` sees and surfaced separately on the envelope instead.
  // `--baseline` runs disable this (opts.suppress === false) so the baseline written
  // afterward captures every finding, not the subset an existing baseline/dismissal
  // already hides.
  let aggregateReports = reports;
  let suppressed: ReturnType<typeof suppressFindings>['suppressed'] = [];
  if (opts.suppress !== false) {
    const baseline = readBaseline(repoRoot);
    const dismissals = readDismissals(repoRoot);
    const suppression = suppressFindings(reports, baseline, dismissals);
    aggregateReports = suppression.reports;
    suppressed = suppression.suppressed;
  }

  const aggregated = aggregate(
    aggregateReports, loaded.config.reviewers, rulesById, loaded.config.aggregation.fail_on_severity,
  );
  // Advisory tier-0 failures annotate the verdict but never change it: the status and
  // exit code stay whatever the reviewers earned.
  const result = {
    ...aggregated,
    decision_reason: withAdvisoryNote(aggregated.decision_reason, tier0Advisory),
  };
  const envelope = buildEnvelope({
    repoRoot, commit: diff.head, base: diff.base,
    config: loaded.config, layers: loaded.layers, authMode,
    rules: applicable, reports: aggregateReports, result,
    costUsd: costTotal, durationMs: Date.now() - started,
    tier0: tier0Result ? toEnvelopeTier0(tier0Result) : null,
    skippedTiers: [...skipTiers],
    suppressed,
    excludedPaths: diff.excluded,
    extraHashInputs: skillContentsForHash,
  });
  return { envelope, exitCode: result.exitCode };
}
