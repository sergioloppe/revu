import { join } from 'node:path';
import { loadEffectiveConfig, type LoadedConfig } from '../config/cascade.js';
import { loadReviewerPersona } from '../catalog/reviewers.js';
import { findDuplicateRuleIds, loadRules, scanRuleCatalog } from '../catalog/rules.js';
import { isLikelyMismatch, unmatchedRules } from '../catalog/coverage.js';
import { git } from '../gitio/repo.js';
import { PACKS, detectLanguage } from '../packs.js';
import { preflight } from '../executor/preflight.js';
import { resolveClaudeBin } from '../executor/run.js';
import { isDismissalActive, readBaseline, readDismissals } from '../suppress.js';
import { findMissingSkills } from '../skills.js';
import { EXIT, REVU_VERSION } from '../constants.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface DoctorCheck { status: 'ok' | 'warn' | 'fail'; message: string }
export interface DoctorResult { checks: DoctorCheck[]; exitCode: number }

const ok = (message: string): DoctorCheck => ({ status: 'ok', message });
const warn = (message: string): DoctorCheck => ({ status: 'warn', message });
const fail = (message: string): DoctorCheck => ({ status: 'fail', message });

function checkClaudeBinary(env: NodeJS.ProcessEnv): DoctorCheck {
  // Only `claude --version` (via preflight) — doctor never spawns a reviewer subprocess.
  // A missing/broken binary is tolerated (caught, not thrown) and reported as a FAIL line.
  try {
    const { authMode } = preflight(resolveClaudeBin(env), env);
    return ok(`claude binary found on PATH (auth mode: ${authMode})`);
  } catch (err) {
    return fail(`claude binary: ${(err as Error).message}`);
  }
}

function checkCatalog(loaded: LoadedConfig): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const personaSources = [
    ...(loaded.globalDir ? [{ dir: loaded.globalDir }] : []),
    ...(loaded.reviewDir ? [{ dir: loaded.reviewDir }] : []),
  ];
  const missingPersonas = loaded.config.reviewers
    .filter((r) => { try { loadReviewerPersona(personaSources, r.id); return false; } catch { return true; } })
    .map((r) => r.id);
  checks.push(missingPersonas.length
    ? fail(`reviewer persona missing for: ${missingPersonas.join(', ')}`)
    : ok(`every configured reviewer (${loaded.config.reviewers.length}) has a persona`));

  const ruleSources = [
    ...(loaded.globalDir ? [{ dir: join(loaded.globalDir, 'rules'), origin: 'global' as const }] : []),
    ...(loaded.reviewDir ? [{ dir: join(loaded.reviewDir, 'rules'), origin: 'repo' as const }] : []),
  ];
  const { entries, errors } = scanRuleCatalog(ruleSources);
  checks.push(...(errors.length
    ? errors.map((e) => fail(`rule frontmatter invalid: ${e.file}: ${e.message}`))
    : [ok(`${entries.length} rule file(s) have valid frontmatter`)]));

  const duplicates = findDuplicateRuleIds(entries);
  checks.push(...(duplicates.length
    ? duplicates.map((d) => fail(`duplicate rule id "${d.id}" declared in: ${d.files.join(', ')}`))
    : [ok('no duplicate rule ids within a layer')]));

  // Global rules always run advisory-only regardless of their declared `blocking`
  // (loadRules forces it false — design §4.3); flag the mismatch so an author whose
  // global rule declares `blocking: true` knows it's silently demoted.
  const globalBlocking = entries.filter((e) => e.origin === 'global' && e.blocking);
  checks.push(...(globalBlocking.length
    ? globalBlocking.map((e) => warn(`global rule ${e.id} declares blocking: true — demoted to advisory (${e.file})`))
    : [ok('no global rules declare blocking: true')]));

  return checks;
}

/**
 * Does the catalog actually apply to this repo? A rule matching nothing is dead: it
 * is filtered out of every run, its reviewer is skipped for want of applicable rules,
 * and the result is a PASS indistinguishable from a clean review. That is what a
 * TypeScript catalog scaffolded into a Go repo looks like — silently green forever.
 */
function checkCoverage(repoRoot: string, loaded: LoadedConfig): DoctorCheck[] {
  let repoFiles: string[];
  try {
    repoFiles = git(repoRoot, ['ls-files']).split('\n').map((f) => f.trim()).filter(Boolean);
  } catch {
    return [warn('could not list repo files (git ls-files failed) — rule coverage not checked')];
  }
  if (repoFiles.length === 0) return [ok('empty repo — rule coverage not checked')];

  const ruleSources = [
    ...(loaded.globalDir ? [{ dir: join(loaded.globalDir, 'rules'), origin: 'global' as const }] : []),
    ...(loaded.reviewDir ? [{ dir: join(loaded.reviewDir, 'rules'), origin: 'repo' as const }] : []),
  ];
  const rules = loadRules(ruleSources);
  if (rules.length === 0) return [warn('no rules in the effective catalog — every run will pass vacuously')];

  const unmatched = unmatchedRules(rules, repoFiles);
  if (unmatched.length === 0) return [ok(`all ${rules.length} rule(s) match files in this repo`)];

  const detected = detectLanguage(repoRoot);
  const hint = detected
    ? ` This looks like a ${PACKS[detected].label} repo — \`revu init --lang ${detected}\` (after moving .review/ aside) scaffolds a matching catalog.`
    : " Check each rule's applies_to globs against this repo's layout.";
  const listed = `${unmatched.length} of ${rules.length} rule(s) match no file in this repo: ${unmatched.join(', ')}`;

  if (unmatched.length === rules.length) {
    return [fail(`${listed} — every run will report PASS without reviewing anything.${hint}`)];
  }
  if (isLikelyMismatch(unmatched.length, rules.length)) {
    return [warn(`${listed} — most of the catalog does not apply here, so runs will look ` +
      `clean while reviewing almost nothing.${hint}`)];
  }
  return [warn(listed)];
}

function checkSkills(loaded: LoadedConfig, env: NodeJS.ProcessEnv): DoctorCheck[] {
  const entries = loaded.config.context.skills;
  const configuredCount = entries.reduce((n, e) => n + e.include.length, 0);
  if (configuredCount === 0) return [ok('no skill-set context configured')];
  const missing = findMissingSkills(entries, env);
  if (missing.length === 0) return [ok(`${configuredCount} configured skill(s) resolve on disk`)];
  // Missing skill-set context never fails a run (it's skipped silently in the
  // pipeline — design §5.3); doctor is where the drift becomes visible.
  return missing.map((m) =>
    warn(`configured skill "${m.source}/${m.name}" not found under the skills home ` +
      `(reviewers: ${m.reviewers.join(', ')}) — will be skipped at run time`));
}

function checkDismissals(repoRoot: string, now: Date): DoctorCheck[] {
  const dismissals = readDismissals(repoRoot);
  const expired = dismissals.filter((d) => !isDismissalActive(d, now));
  const expiringSoon = dismissals.filter((d) =>
    isDismissalActive(d, now) && new Date(d.expires).getTime() - now.getTime() < THIRTY_DAYS_MS);
  if (!expired.length && !expiringSoon.length) {
    return [ok(`${dismissals.length} dismissal(s) on file, none expired or expiring within 30 days`)];
  }
  return [
    ...expired.map((d) => warn(`dismissal ${d.id} (${d.rule}) expired on ${d.expires}`)),
    ...expiringSoon.map((d) => warn(`dismissal ${d.id} (${d.rule}) expires soon: ${d.expires}`)),
  ];
}

function checkBaseline(repoRoot: string): DoctorCheck {
  const baseline = readBaseline(repoRoot);
  return ok(baseline ? `baseline recorded: ${baseline.findings.length} finding(s)` : 'no baseline recorded');
}

/** Runs every doctor check (plan Task 6). Warnings never fail the run; any FAIL does. */
export function runDoctor(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): DoctorResult {
  // First line, always: a bug report that doesn't say which revu produced it costs a
  // round trip before anything else can be diagnosed.
  const checks: DoctorCheck[] = [
    ok(`revu ${REVU_VERSION} (node ${process.version}, ${process.platform})`),
    checkClaudeBinary(env),
  ];

  let loaded: LoadedConfig | null = null;
  try {
    loaded = loadEffectiveConfig(repoRoot, env);
    checks.push(ok(`effective config parses (layers: ${loaded.layers.join('+')})`));
  } catch (err) {
    checks.push(fail(`effective config: ${(err as Error).message}`));
  }
  if (loaded) checks.push(...checkCatalog(loaded), ...checkCoverage(repoRoot, loaded), ...checkSkills(loaded, env));

  checks.push(...checkDismissals(repoRoot, now));
  checks.push(checkBaseline(repoRoot));

  const exitCode = checks.some((c) => c.status === 'fail') ? EXIT.TOOL_ERROR : EXIT.PASS;
  return { checks, exitCode };
}

export function doctorCommand(repoRoot: string, env: NodeJS.ProcessEnv = process.env): number {
  const { checks, exitCode } = runDoctor(repoRoot, env);
  for (const c of checks) console.log(`[${c.status}] ${c.message}`);
  return exitCode;
}
