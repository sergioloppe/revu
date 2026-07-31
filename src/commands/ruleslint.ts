import { join } from 'node:path';
import { loadEffectiveConfig } from '../config/cascade.js';
import { findDuplicateRuleIds, scanRuleCatalog, type RuleCatalogEntry, type RuleCatalogIssue } from '../catalog/rules.js';
import { ConfigError, ToolError } from '../errors.js';
import { EXIT } from '../constants.js';

export interface RulesLintResult {
  errors: RuleCatalogIssue[];
  duplicates: Array<{ id: string; files: string[] }>;
  entries: RuleCatalogEntry[];
}

/** Frontmatter validity + same-layer duplicate-id checks across the effective catalog. */
export function lintRules(repoRoot: string, env: NodeJS.ProcessEnv = process.env): RulesLintResult {
  const loaded = loadEffectiveConfig(repoRoot, env);
  const sources = [
    ...(loaded.globalDir ? [{ dir: join(loaded.globalDir, 'rules'), origin: 'global' as const }] : []),
    ...(loaded.reviewDir ? [{ dir: join(loaded.reviewDir, 'rules'), origin: 'repo' as const }] : []),
  ];
  const { entries, errors } = scanRuleCatalog(sources);
  const duplicates = findDuplicateRuleIds(entries);
  return { errors, duplicates, entries };
}

export function rulesLintCommand(repoRoot: string, env: NodeJS.ProcessEnv = process.env): number {
  let result: RulesLintResult;
  try {
    result = lintRules(repoRoot, env);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ToolError) {
      console.error(`revu rules lint: ${err.message}`);
      return EXIT.TOOL_ERROR;
    }
    throw err;
  }
  const { errors, duplicates, entries } = result;
  for (const err of errors) console.error(`[error] ${err.file}: invalid frontmatter: ${err.message}`);
  for (const dup of duplicates) {
    console.error(`[error] duplicate rule id "${dup.id}" declared in: ${dup.files.join(', ')}`);
  }
  if (errors.length === 0 && duplicates.length === 0) {
    console.log(`rules lint: ${entries.length} rule(s) ok`);
    return EXIT.PASS;
  }
  return EXIT.TOOL_ERROR;
}
