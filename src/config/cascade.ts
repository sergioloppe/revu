import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ConfigSchema, type EffectiveConfig } from './schema.js';
import { ConfigError } from '../errors.js';

export type Layer = 'builtin' | 'global' | 'repo';
export interface LoadedConfig {
  config: EffectiveConfig;
  layers: Layer[];
  globalDir: string | null;
  reviewDir: string | null;
}

function readYaml(path: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${path}: invalid YAML: ${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${path}: expected a YAML mapping`);
  }
  return raw as Record<string, unknown>;
}

/** Recursively reject the forbidden key with a security explanation (design §3.2). */
function rejectAllowedTools(node: unknown, path: string): void {
  if (Array.isArray(node)) { node.forEach((v, i) => rejectAllowedTools(v, `${path}[${i}]`)); return; }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'allowed_tools') {
      throw new ConfigError(
        `${path}.allowed_tools: the reviewer read-only toolset is not configurable. ` +
        `Reviewers always run with Read,Grep,Glob only; remove this key.`,
      );
    }
    rejectAllowedTools(value, `${path}.${key}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge: higher layer wins per key; arrays replace, EXCEPT reviewers merge by id. */
function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (key === 'reviewers' && Array.isArray(base[key]) && Array.isArray(value)) {
      const byId = new Map<string, unknown>();
      for (const r of base[key] as Array<Record<string, unknown>>) byId.set(String(r.id), r);
      for (const r of value as Array<Record<string, unknown>>) byId.set(String(r.id), r);
      out[key] = [...byId.values()];
    } else if (isPlainObject(base[key]) && isPlainObject(value)) {
      out[key] = merge(base[key] as Record<string, unknown>, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function globalConfigDir(env: NodeJS.ProcessEnv): string {
  return env.REVU_CONFIG_HOME ?? join(homedir(), '.config', 'revu');
}

export function loadEffectiveConfig(repoRoot: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const gDir = globalConfigDir(env);
  const gPath = join(gDir, 'config.yaml');
  const rDir = join(repoRoot, '.review');
  const rPath = join(rDir, 'config.yaml');

  const repoRaw = existsSync(rPath) ? readYaml(rPath) : null;
  if (repoRaw) rejectAllowedTools(repoRaw, '.review/config.yaml');
  const inheritGlobal = repoRaw?.inherit_global !== false;

  const globalRaw = inheritGlobal && existsSync(gPath) ? readYaml(gPath) : null;
  if (globalRaw) rejectAllowedTools(globalRaw, 'global config.yaml');

  const layers: Layer[] = ['builtin'];
  let mergedRaw: Record<string, unknown> = { schema_version: 1 };
  if (globalRaw) { mergedRaw = merge(mergedRaw, globalRaw); layers.push('global'); }
  if (repoRaw) { mergedRaw = merge(mergedRaw, repoRaw); layers.push('repo'); }

  const parsed = ConfigSchema.safeParse(mergedRaw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`invalid effective config: ${detail}`);
  }
  return {
    config: parsed.data,
    layers,
    globalDir: globalRaw ? gDir : null,
    reviewDir: existsSync(rDir) ? rDir : null,
  };
}
