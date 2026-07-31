import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEffectiveConfig } from '../src/config/cascade.js';
import { ConfigError } from '../src/errors.js';

let repo: string; let globalDir: string;
const env = () => ({ REVU_CONFIG_HOME: globalDir });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'revu-repo-'));
  globalDir = mkdtempSync(join(tmpdir(), 'revu-global-'));
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); rmSync(globalDir, { recursive: true, force: true }); });

describe('config cascade', () => {
  it('returns builtin defaults when no config exists anywhere', () => {
    // point the global dir somewhere empty so a real ~/.config/revu cannot leak in
    const { config, layers } = loadEffectiveConfig(repo, { REVU_CONFIG_HOME: '/nonexistent-global' });
    expect(layers).toEqual(['builtin']);
    expect(config.defaults.model).toBe('claude-sonnet-5');
    expect(config.aggregation.fail_on_severity).toBe('high');
    expect(config.auth.mode).toBe('auto');
  });

  it('merges global under repo, repo wins key-by-key', () => {
    mkdirSync(join(globalDir), { recursive: true });
    writeFileSync(join(globalDir, 'config.yaml'),
      'schema_version: 1\ndefaults:\n  model: claude-haiku-4-5\n  timeout_seconds: 60\n');
    mkdirSync(join(repo, '.review'));
    writeFileSync(join(repo, '.review', 'config.yaml'),
      'schema_version: 1\ndefaults:\n  model: claude-opus-4-8\n');
    const { config, layers } = loadEffectiveConfig(repo, env());
    expect(layers).toEqual(['builtin', 'global', 'repo']);
    expect(config.defaults.model).toBe('claude-opus-4-8');   // repo wins
    expect(config.defaults.timeout_seconds).toBe(60);        // global survives
  });

  it('merges reviewers by id, repo replacing global', () => {
    writeFileSync(join(globalDir, 'config.yaml'),
      'schema_version: 1\nreviewers:\n  - id: security\n    tier: 1\n    rules: rules/security/**\n    model: claude-sonnet-5\n');
    mkdirSync(join(repo, '.review'));
    writeFileSync(join(repo, '.review', 'config.yaml'),
      'schema_version: 1\nreviewers:\n  - id: security\n    tier: 1\n    rules: rules/security/**\n    model: claude-opus-4-8\n');
    const { config } = loadEffectiveConfig(repo, env());
    expect(config.reviewers).toHaveLength(1);
    expect(config.reviewers[0]!.model).toBe('claude-opus-4-8');
  });

  it('inherit_global: false skips the global layer', () => {
    writeFileSync(join(globalDir, 'config.yaml'), 'schema_version: 1\ndefaults:\n  timeout_seconds: 7\n');
    mkdirSync(join(repo, '.review'));
    writeFileSync(join(repo, '.review', 'config.yaml'), 'schema_version: 1\ninherit_global: false\n');
    const { config, layers } = loadEffectiveConfig(repo, env());
    expect(layers).toEqual(['builtin', 'repo']);
    expect(config.defaults.timeout_seconds).toBe(120);
  });

  it('rejects allowed_tools anywhere with a security message', () => {
    mkdirSync(join(repo, '.review'));
    writeFileSync(join(repo, '.review', 'config.yaml'),
      'schema_version: 1\ndefaults:\n  allowed_tools: [Read, Bash]\n');
    expect(() => loadEffectiveConfig(repo, env())).toThrow(ConfigError);
    expect(() => loadEffectiveConfig(repo, env())).toThrow(/read-only toolset is not configurable/i);
  });

  it('applies reviewer defaults: model and min_confidence_to_block', () => {
    mkdirSync(join(repo, '.review'));
    writeFileSync(join(repo, '.review', 'config.yaml'),
      'schema_version: 1\nreviewers:\n  - id: security\n    tier: 1\n    rules: rules/security/**\n');
    const { config } = loadEffectiveConfig(repo, env());
    expect(config.reviewers[0]!.model).toBe('claude-sonnet-5');
    expect(config.reviewers[0]!.min_confidence_to_block).toBe(0.85);
  });

  it('rejects malformed YAML with a ConfigError containing invalid YAML message', () => {
    mkdirSync(join(repo, '.review'));
    writeFileSync(join(repo, '.review', 'config.yaml'), 'schema_version: [unclosed');
    expect(() => loadEffectiveConfig(repo, env())).toThrow(ConfigError);
    expect(() => loadEffectiveConfig(repo, env())).toThrow(/invalid YAML/i);
  });
});
