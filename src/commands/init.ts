import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { globalConfigDir } from '../config/cascade.js';
import { findRepoRoot, git } from '../gitio/repo.js';
import { REPORT_JSON_SCHEMA } from '../report/schema.js';
import { loadRules } from '../catalog/rules.js';
import { isLikelyMismatch, unmatchedRules } from '../catalog/coverage.js';
import { CLAUDE_COMMAND_TEMPLATES, LEFTHOOK_YML } from '../templates-claude.js';
import { PACKS, detectLanguage, isLanguage, LANGUAGES, type Language } from '../packs.js';

/**
 * `revu init --claude` (design §5.2): writes the three Claude Code slash-command
 * prompts into `.claude/commands/`. Refuses (leaving nothing written) if any of
 * the three already exist, matching the config.yaml overwrite-refusal below.
 */
function initClaude(repoRoot: string): number {
  const claudeDir = join(repoRoot, '.claude', 'commands');
  const conflicts = Object.keys(CLAUDE_COMMAND_TEMPLATES).filter((rel) => existsSync(join(claudeDir, rel)));
  if (conflicts.length) {
    console.error(`revu init --claude: refusing to overwrite existing file(s): ${
      conflicts.map((rel) => join(claudeDir, rel)).join(', ')}`);
    return 3;
  }
  for (const [rel, content] of Object.entries(CLAUDE_COMMAND_TEMPLATES)) {
    const path = join(claudeDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`created ${path}`);
  }
  return 0;
}

/**
 * `revu init` writes `lefthook.yml` at the repo root, but only if one isn't
 * already there — lefthook.yml is shared infrastructure a repo may already have
 * its own hooks in, so revu only ever adds to an absent file, never merges into
 * or overwrites an existing one.
 */
function writeLefthookIfAbsent(repoRoot: string): void {
  const path = join(repoRoot, 'lefthook.yml');
  if (existsSync(path)) return;
  writeFileSync(path, LEFTHOOK_YML);
  console.log(`created ${path}`);
}

/**
 * Warns when the freshly scaffolded catalog doesn't match the repo it was written
 * into — the failure mode that makes a wrong-language catalog invisible: every rule
 * is filtered out, every reviewer is skipped, and the run reports PASS.
 */
function reportCoverage(repoRoot: string, reviewDir: string, language: Language): void {
  let repoFiles: string[];
  try {
    repoFiles = git(repoRoot, ['ls-files']).split('\n').map((f) => f.trim()).filter(Boolean);
  } catch {
    return; // not a git repo, or git unavailable: nothing to compare against
  }
  if (repoFiles.length === 0) return;

  const rules = loadRules([{ dir: join(reviewDir, 'rules'), origin: 'repo' }]);
  const unmatched = unmatchedRules(rules, repoFiles);
  if (unmatched.length === 0) return;

  if (isLikelyMismatch(unmatched.length, rules.length)) {
    const detected = detectLanguage(repoRoot);
    console.error(
      `\nrevu init: WARNING — ${unmatched.length} of the ${rules.length} rules just scaffolded match ` +
      `no file in this repo.\n` +
      `  The ${PACKS[language].label} pack was installed, so most reviewers will be skipped and runs\n` +
      `  will look clean while reviewing almost nothing.\n` +
      (detected && detected !== language
        ? `  This looks like a ${PACKS[detected].label} repo — rm -rf ${reviewDir} && revu init --lang ${detected}\n`
        : `  Re-run with another pack (${LANGUAGES.join(' | ')}) after removing ${reviewDir}, ` +
          "or edit each rule's applies_to globs.\n"));
    return;
  }
  console.log(`\nnote: ${unmatched.length} of ${rules.length} rule(s) match no file in this repo ` +
    `(${unmatched.join(', ')}).\n  They stay dormant until such files exist — adjust applies_to if that's wrong.`);
}

export function initCommand(
  cwd: string,
  opts: { global?: boolean; claude?: boolean; lang?: string },
  env: NodeJS.ProcessEnv = process.env,
): number {
  const target = opts.global ? globalConfigDir(env) : join(findRepoRoot(cwd), '.review');
  if (existsSync(join(target, 'config.yaml'))) {
    console.error(`revu init: ${target}/config.yaml already exists — refusing to overwrite`);
    return 3;
  }

  let language: Language;
  if (opts.lang !== undefined) {
    if (!isLanguage(opts.lang)) {
      console.error(`revu init: unknown --lang "${opts.lang}" (expected one of: ${LANGUAGES.join(', ')})`);
      return 3;
    }
    language = opts.lang;
  } else {
    // Detection only makes sense for a repo catalog; the global one has no repo to
    // inspect. Falling back to 'ts' keeps the historical default, and the coverage
    // warning below is what catches a mismatch either way.
    const detected = opts.global ? null : detectLanguage(findRepoRoot(cwd));
    language = detected ?? 'ts';
    if (detected) console.log(`detected ${PACKS[detected].label} — installing the ${detected} rule pack`);
  }

  if (opts.claude) {
    const code = initClaude(findRepoRoot(cwd));
    if (code !== 0) return code;
  }
  // The pre-push hook is repo-root scoped infrastructure, independent of whether
  // this invocation is scaffolding the repo or global catalog.
  if (!opts.global) writeLefthookIfAbsent(findRepoRoot(cwd));

  const files: Record<string, string> = {
    ...PACKS[language].files,
    'schema/report.schema.json': REPORT_JSON_SCHEMA,
    // The review cache is machine-local, reproducible from source inputs, and
    // potentially large — never commit it.
    '.gitignore': 'cache/\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    const path = join(target, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`created ${path}`);
  }
  if (!opts.global) reportCoverage(findRepoRoot(cwd), target, language);
  return 0;
}
