#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { runPipeline } from './pipeline.js';
import { findRepoRoot, git } from './gitio/repo.js';
import { renderPretty } from './render/pretty.js';
import { ConfigError, SecurityViolationError, ToolError } from './errors.js';
import { EXIT, REVU_VERSION } from './constants.js';
import { initCommand } from './commands/init.js';
import { doctorCommand } from './commands/doctor.js';
import { rulesLintCommand } from './commands/ruleslint.js';
import { configShowCommand, configPromoteCommand } from './commands/config.js';
import { appendDismissal, writeBaseline } from './suppress.js';
import { createReporter, silentReporter } from './progress.js';
import { LANGUAGES } from './packs.js';
import type { AggregateEnvelope } from './report/envelope.js';

const DISMISSAL_LIFETIME_DAYS = 180;

/**
 * `revu --dismiss <id> --reason "..."`: appends a dismissal entry, refusing (exit 3)
 * unless `id` names a finding in the most recent `.review-report.json` — a run has to
 * have actually surfaced the finding before it can be dismissed.
 */
function dismissCommand(repoRoot: string, id: string, reason: string): number {
  const reportPath = join(repoRoot, '.review-report.json');
  if (!existsSync(reportPath)) {
    console.error(`revu --dismiss: no ${reportPath} found — run revu first`);
    return EXIT.TOOL_ERROR;
  }
  let envelope: AggregateEnvelope;
  try {
    envelope = JSON.parse(readFileSync(reportPath, 'utf8')) as AggregateEnvelope;
  } catch {
    console.error(`revu --dismiss: ${reportPath} is not valid JSON`);
    return EXIT.TOOL_ERROR;
  }
  const match = envelope.reviews.flatMap((r) => r.issues).find((i) => i.id === id);
  if (!match) {
    console.error(`revu --dismiss: finding id "${id}" not found in ${reportPath}`);
    return EXIT.TOOL_ERROR;
  }
  // `git config user.name` exits non-zero (git() throws a ToolError) when the key is
  // unset, rather than printing an empty string — so the `|| 'unknown'` fallback alone
  // never fires in that case. Catch explicitly so a repo/global config without
  // user.name still gets a dismissal recorded instead of crashing the command.
  let approvedBy: string;
  try {
    approvedBy = git(repoRoot, ['config', 'user.name']) || 'unknown';
  } catch {
    approvedBy = 'unknown';
  }
  const expires = new Date(Date.now() + DISMISSAL_LIFETIME_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  appendDismissal(repoRoot, { id, rule: match.rule, reason, approved_by: approvedBy, expires });
  console.log(`dismissed ${id} (${match.rule}), expires ${expires}`);
  return EXIT.PASS;
}

const program = new Command();
program.name('revu').version(REVU_VERSION)
  .description('AI code review over a git diff. With no flags, reviews the commits on ' +
    'this branch since its merge base with main — uncommitted work is NOT included ' +
    '(use --staged or --working for that).')
  .option('--staged', 'review staged changes only (git diff --cached)')
  .option('--working', 'review all uncommitted changes to tracked files (git diff HEAD)')
  .option('--range <range>', 'explicit git range, e.g. main...HEAD')
  .option('--files <files...>', 'limit review to these files')
  .option('--only <ids>', 'comma-separated reviewer ids to run, regardless of tier',
    (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .option('--skip <ids>', 'comma-separated reviewer ids to exclude',
    (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .option('--tier <n>', 'run reviewers at or below this tier (0, 1, or 2); 0 runs tier-0 checks only',
    (v: string) => {
      const n = Number(v);
      if (n !== 0 && n !== 1 && n !== 2) {
        console.error(`revu: --tier must be 0, 1, or 2 (got "${v}")`);
        process.exit(EXIT.TOOL_ERROR);
      }
      return n as 0 | 1 | 2;
    })
  .option('--skip-tier <tiers>',
    'comma-separated tiers to skip entirely, e.g. 0 (deterministic checks) or 0,2',
    (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const n = Number(s);
      if (n !== 0 && n !== 1 && n !== 2) {
        console.error(`revu: --skip-tier takes 0, 1, or 2 (got "${s}")`);
        process.exit(EXIT.TOOL_ERROR);
      }
      return n as 0 | 1 | 2;
    }))
  // No default: an omitted --format follows the TTY (pretty for a human, json for a
  // pipe), but an explicit --format pretty must win even when stdout is redirected.
  .option('--format <format>', 'pretty | json (default: pretty on a TTY, json when piped)')
  .option('--output <path>', 'write the JSON envelope to this path')
  .option('--no-cache', 'bypass the review cache on read (writes still happen)')
  .option('--baseline', 'run the pipeline and record every finding to .review/baseline.json, then exit 0')
  .option('--dismiss <id>', 'append a dismissal for this finding id to .review/dismissals.yaml')
  .option('--reason <text>', 'reason for --dismiss (required with --dismiss)')
  .option('-q, --quiet', 'suppress progress output on stderr')
  .addHelpText('after', `
What gets reviewed
  revu                     commits on this branch since the merge base with main
  revu --staged            what \`git add\` has staged
  revu --working           every uncommitted change to a tracked file
  revu --range main...HEAD an explicit range
  revu --files a.ts b.ts   narrow any of the above to specific paths

Common runs
  revu --tier 0            deterministic checks only (build/lint/test) — no AI spend
  revu --skip-tier 0       skip the deterministic checks (e.g. a pre-existing vet failure)
  revu --skip-tier 2       blocking committee only, no advisory reviewers
  revu --only security     run one reviewer
  revu --format json       machine-readable envelope on stdout
  revu -q                  no progress output

Managing findings
  revu --baseline                  accept every current finding, fail only on new ones
  revu --dismiss <id> --reason "…" retire one finding

Other commands
  revu init | doctor | rules lint | config show    (revu <command> --help for detail)

Exit codes
  0 pass · 1 blocking findings · 2 needs human review · 3 tool error · 4 tier-0 check failed

Progress goes to stderr; the report goes to stdout.`)
  .action(async (opts) => {
    const reporter = opts.quiet ? silentReporter : createReporter();
    try {
      const modes = ['staged', 'working', 'range'].filter((m) => opts[m]);
      if (modes.length > 1) {
        console.error(`revu: --${modes.join(' and --')} are mutually exclusive — pick one`);
        process.exitCode = EXIT.TOOL_ERROR;
        return;
      }
      const skipTiers: Array<0 | 1 | 2> = opts.skipTier ?? [];
      // `--tier N` already means "at or below N"; skipping N as well leaves an empty
      // selection, which would otherwise surface as a vacuous PASS.
      if (opts.tier !== undefined && skipTiers.includes(opts.tier)) {
        console.error(`revu: --tier ${opts.tier} and --skip-tier ${opts.tier} cancel out — nothing would run`);
        process.exitCode = EXIT.TOOL_ERROR;
        return;
      }
      if ([0, 1, 2].every((t) => skipTiers.includes(t as 0 | 1 | 2))) {
        console.error('revu: --skip-tier 0,1,2 skips everything — nothing would run');
        process.exitCode = EXIT.TOOL_ERROR;
        return;
      }
      if (opts.dismiss) {
        if (!opts.reason) {
          console.error('revu --dismiss requires --reason "..."');
          process.exitCode = EXIT.TOOL_ERROR;
          return;
        }
        const repoRoot = findRepoRoot(process.cwd());
        process.exitCode = dismissCommand(repoRoot, opts.dismiss, opts.reason);
        return;
      }

      const { envelope, exitCode } = await runPipeline(process.cwd(), {
        staged: opts.staged, working: opts.working, range: opts.range, files: opts.files,
        only: opts.only, skip: opts.skip, tier: opts.tier, skipTiers, cache: opts.cache,
        reporter,
        // --baseline wants every finding this run produced, not the subset an
        // existing baseline/dismissal already suppresses.
        suppress: opts.baseline ? false : undefined,
      });
      const repoRoot = findRepoRoot(process.cwd());
      writeFileSync(opts.output ?? join(repoRoot, '.review-report.json'),
        JSON.stringify(envelope, null, 2));

      if (opts.baseline) {
        if (exitCode !== EXIT.PASS && exitCode !== EXIT.FAIL && exitCode !== EXIT.NEEDS_HUMAN) {
          // A pipeline-level failure (tier 0, exit 4; or any other non-review-outcome
          // exit) means reviewers may never have run, so `envelope.reviews` doesn't
          // reflect a real review. Writing a baseline from it would silently record
          // "0 findings", clobber a real existing baseline, and exit 0 — masking the
          // underlying failure. Refuse, and propagate the real exit code instead.
          console.error(`revu --baseline: pipeline failed (exit ${exitCode}) — baseline NOT written`);
          process.exitCode = exitCode;
          return;
        }
        const baseline = writeBaseline(repoRoot, envelope.reviews);
        console.log(`baseline recorded (${baseline.findings.length} findings)`);
        process.exitCode = EXIT.PASS; // --baseline never fails the run on a normal review outcome
        return;
      }

      if (opts.format !== undefined && opts.format !== 'json' && opts.format !== 'pretty') {
        console.error(`revu: --format must be pretty or json (got "${opts.format}")`);
        process.exitCode = EXIT.TOOL_ERROR;
        return;
      }
      const format = opts.format ?? (process.stdout.isTTY ? 'pretty' : 'json');
      if (format === 'json') {
        console.log(JSON.stringify(envelope, null, 2));
      } else {
        if (!opts.quiet) process.stderr.write('\n'); // separate progress from the report
        console.log(renderPretty(envelope, true));
      }
      process.exitCode = exitCode;
    } catch (err) {
      if (err instanceof SecurityViolationError) {
        console.error(err.message);
      } else if (err instanceof ConfigError || err instanceof ToolError) {
        console.error(`revu: ${err.message}`);
      } else {
        console.error(`revu: unexpected error: ${(err as Error).stack}`);
      }
      process.exitCode = EXIT.TOOL_ERROR;
    } finally {
      reporter.done();
    }
  });

program.command('init')
  .description('scaffold a starter .review/ catalog for this repo\'s language')
  .option('--lang <language>', `rule pack to install: ${LANGUAGES.join(' | ')} ` +
    '(default: detected from go.mod / package.json)')
  .option('--global', 'scaffold the global config dir instead')
  .option('--claude', 'also write the /revu, /revu-rule, /revu-triage Claude Code commands')
  .action((opts) => {
    process.exitCode = initCommand(process.cwd(),
      { global: opts.global, claude: opts.claude, lang: opts.lang });
  });

program.command('doctor')
  .description('run environment, auth, and catalog health checks (exit 3 on any failing check)')
  .action(() => { process.exitCode = doctorCommand(findRepoRoot(process.cwd())); });

const rules = program.command('rules').description('rule catalog utilities');
rules.command('lint')
  .description('validate rule frontmatter and detect duplicate ids across the effective catalog')
  .action(() => { process.exitCode = rulesLintCommand(findRepoRoot(process.cwd())); });

const config = program.command('config').description('config cascade utilities');
config.command('show')
  .description('print the effective merged config as YAML')
  .option('--effective', 'show the merged effective config (currently the only mode)')
  .action(() => { process.exitCode = configShowCommand(findRepoRoot(process.cwd())); });
config.command('promote <ruleId>')
  .description('copy a global rule file into .review/rules/<domain>/, taking local ownership')
  .action((ruleId: string) => {
    process.exitCode = configPromoteCommand(findRepoRoot(process.cwd()), ruleId);
  });

program.showHelpAfterError('(run `revu --help` for the full option list)');
program.parseAsync();
