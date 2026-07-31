import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { configShowCommand, configPromoteCommand } from '../src/commands/config.js';

let repoRoot: string; let globalDir: string;
const env = () => ({ REVU_CONFIG_HOME: globalDir });

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'revu-cfgcmd-repo-'));
  globalDir = mkdtempSync(join(tmpdir(), 'revu-cfgcmd-global-'));
});
afterEach(() => { rmSync(repoRoot, { recursive: true, force: true }); rmSync(globalDir, { recursive: true, force: true }); });

describe('configShowCommand', () => {
  it('prints a layers header comment followed by valid YAML of the effective config', () => {
    mkdirSync(join(repoRoot, '.review'));
    writeFileSync(join(repoRoot, '.review', 'config.yaml'),
      'schema_version: 1\ndefaults:\n  model: claude-opus-4-8\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(configShowCommand(repoRoot, env())).toBe(0);
      const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(out).toMatch(/^# layers: builtin\+repo/);
      const yamlBody = out.split('\n').slice(1).join('\n');
      const parsed = parseYaml(yamlBody);
      expect(parsed.defaults.model).toBe('claude-opus-4-8');
      expect(parsed.schema_version).toBe(1);
    } finally { log.mockRestore(); }
  });

  it('exits 3 on an invalid config instead of throwing', () => {
    mkdirSync(join(repoRoot, '.review'));
    writeFileSync(join(repoRoot, '.review', 'config.yaml'), 'schema_version: [unclosed');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(configShowCommand(repoRoot, env())).toBe(3);
    } finally { errSpy.mockRestore(); }
  });
});

describe('configPromoteCommand', () => {
  function globalRule(id: string, domain = 'security') {
    const path = join(globalDir, 'rules', domain, `${id}.md`);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `---\nid: ${id}\ndomain: ${domain}\nseverity: high\nblocking: false\nstatus: active\n---\n\nBody.\n`);
    return path;
  }

  it('copies the global rule file into .review/rules/<domain>/', () => {
    globalRule('SEC-001');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(configPromoteCommand(repoRoot, 'SEC-001', env())).toBe(0);
    } finally { log.mockRestore(); }
    const destPath = join(repoRoot, '.review', 'rules', 'security', 'SEC-001.md');
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, 'utf8')).toContain('id: SEC-001');
  });

  it('exits 3 when the rule is not found in the global layer', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(configPromoteCommand(repoRoot, 'NOPE-001', env())).toBe(3);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('not found');
    } finally { errSpy.mockRestore(); }
  });

  it('exits 3 when the rule already exists in the repo catalog', () => {
    globalRule('SEC-001');
    expect(configPromoteCommand(repoRoot, 'SEC-001', env())).toBe(0);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(configPromoteCommand(repoRoot, 'SEC-001', env())).toBe(3);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('already exists');
    } finally { errSpy.mockRestore(); }
  });
});
