import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { globalConfigDir, loadEffectiveConfig } from '../config/cascade.js';
import { scanRuleCatalog } from '../catalog/rules.js';
import { ConfigError, ToolError } from '../errors.js';
import { EXIT } from '../constants.js';

/** `revu config show --effective`: merged config as YAML with a layer-provenance header. */
export function configShowCommand(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  try {
    const loaded = loadEffectiveConfig(repoRoot, env);
    console.log(`# layers: ${loaded.layers.join('+')}`);
    console.log(stringifyYaml(loaded.config).trimEnd());
    return EXIT.PASS;
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ToolError) {
      console.error(`revu config show: ${err.message}`);
      return EXIT.TOOL_ERROR;
    }
    throw err;
  }
}

/**
 * `revu config promote <RULE-ID>`: copies the named rule's file from the global
 * catalog into `.review/rules/<domain>/`, so a repo can take local ownership of
 * (and start blocking on) a rule it previously only inherited advisory from
 * global. Errors (exit 3) if the rule isn't found in the global layer, or a repo
 * rule already occupies the destination path.
 */
export function configPromoteCommand(
  repoRoot: string,
  ruleId: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const globalRulesDir = join(globalConfigDir(env), 'rules');
  const { entries } = scanRuleCatalog([{ dir: globalRulesDir, origin: 'global' }]);
  const match = entries.find((e) => e.id === ruleId);
  if (!match) {
    console.error(`revu config promote: rule "${ruleId}" not found under ${globalRulesDir}`);
    return EXIT.TOOL_ERROR;
  }
  const destDir = join(repoRoot, '.review', 'rules', match.domain);
  const destPath = join(destDir, basename(match.file));
  if (existsSync(destPath)) {
    console.error(`revu config promote: ${destPath} already exists in the repo catalog`);
    return EXIT.TOOL_ERROR;
  }
  mkdirSync(destDir, { recursive: true });
  copyFileSync(match.file, destPath);
  console.log(`promoted ${ruleId} -> ${destPath}`);
  return EXIT.PASS;
}
