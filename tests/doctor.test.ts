import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runDoctor, doctorCommand } from '../src/commands/doctor.js';
import { appendDismissal, writeBaseline } from '../src/suppress.js';

const SHIM = resolve('tests/fixtures/fake-claude.mjs');

let repoRoot: string; let globalDir: string;
beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'revu-doctor-repo-'));
  globalDir = mkdtempSync(join(tmpdir(), 'revu-doctor-global-'));
});
afterEach(() => { rmSync(repoRoot, { recursive: true, force: true }); rmSync(globalDir, { recursive: true, force: true }); });

const baseEnv = () => ({
  PATH: process.env.PATH!, HOME: process.env.HOME!,
  REVU_CONFIG_HOME: globalDir, REVU_CLAUDE_BIN: SHIM,
});

function repoConfig(reviewersYaml = '') {
  mkdirSync(join(repoRoot, '.review'), { recursive: true });
  writeFileSync(join(repoRoot, '.review', 'config.yaml'), `schema_version: 1\n${reviewersYaml}`);
}
function rule(dir: string, rel: string, opts: { id: string; domain?: string; blocking?: boolean }) {
  const path = join(dir, 'rules', rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `---\nid: ${opts.id}\ndomain: ${opts.domain ?? 'security'}\nseverity: high\n` +
    `blocking: ${opts.blocking ?? false}\nstatus: active\n---\n\nBody.\n`);
}

describe('runDoctor', () => {
  it('reports ok across the board on a clean, minimal repo', () => {
    repoConfig();
    const { checks, exitCode } = runDoctor(repoRoot, baseEnv());
    expect(exitCode).toBe(0);
    expect(checks.every((c) => c.status !== 'fail')).toBe(true);
    expect(checks.find((c) => c.message.includes('claude binary'))).toMatchObject({ status: 'ok' });
    expect(checks.find((c) => c.message.includes('no baseline'))).toBeTruthy();
  });

  it('fails the claude binary check (but tolerates the absence) when the binary is missing', () => {
    repoConfig();
    const { checks, exitCode } = runDoctor(repoRoot, { ...baseEnv(), REVU_CLAUDE_BIN: '/nonexistent/claude' });
    expect(checks[0]).toMatchObject({ status: 'fail' });
    expect(exitCode).toBe(3);
  });

  it('fails when the effective config does not parse', () => {
    mkdirSync(join(repoRoot, '.review'), { recursive: true });
    writeFileSync(join(repoRoot, '.review', 'config.yaml'), 'schema_version: [unclosed');
    const { checks, exitCode } = runDoctor(repoRoot, baseEnv());
    expect(checks.some((c) => c.status === 'fail' && c.message.includes('effective config'))).toBe(true);
    expect(exitCode).toBe(3);
    // independent checks (dismissals, baseline) still run despite the config failure
    expect(checks.some((c) => c.message.includes('baseline'))).toBe(true);
  });

  it('fails when a configured reviewer has no persona file', () => {
    repoConfig('reviewers:\n  - id: ghost\n    tier: 1\n    rules: rules/security/**\n');
    const { checks, exitCode } = runDoctor(repoRoot, baseEnv());
    expect(checks.some((c) => c.status === 'fail' && c.message.includes('ghost'))).toBe(true);
    expect(exitCode).toBe(3);
  });

  it('fails on invalid rule frontmatter', () => {
    repoConfig();
    mkdirSync(join(repoRoot, '.review', 'rules', 'security'), { recursive: true });
    writeFileSync(join(repoRoot, '.review', 'rules', 'security', 'BAD.md'), '---\ntitle: no id\n---\n\nbody\n');
    const { checks, exitCode } = runDoctor(repoRoot, baseEnv());
    expect(checks.some((c) => c.status === 'fail' && c.message.includes('invalid'))).toBe(true);
    expect(exitCode).toBe(3);
  });

  it('fails on a duplicate rule id within the repo layer', () => {
    repoConfig();
    rule(join(repoRoot, '.review'), 'security/SEC-001.md', { id: 'SEC-001' });
    rule(join(repoRoot, '.review'), 'security2/OTHER.md', { id: 'SEC-001' });
    const { checks, exitCode } = runDoctor(repoRoot, baseEnv());
    expect(checks.some((c) => c.status === 'fail' && c.message.includes('duplicate'))).toBe(true);
    expect(exitCode).toBe(3);
  });

  it('warns (without failing) when a global rule declares blocking: true', () => {
    writeFileSync(join(globalDir, 'config.yaml'), 'schema_version: 1\n');
    rule(globalDir, 'security/SEC-001.md', { id: 'SEC-001', blocking: true });
    repoConfig();
    const { checks, exitCode } = runDoctor(repoRoot, baseEnv());
    const c = checks.find((x) => x.message.includes('SEC-001') && x.message.includes('demoted'));
    expect(c).toMatchObject({ status: 'warn' });
    expect(exitCode).toBe(0);
  });

  it('warns on an expired dismissal and on one expiring within 30 days', () => {
    repoConfig();
    appendDismissal(repoRoot, { id: 'a1', rule: 'SEC-001', reason: 'r', approved_by: 'x', expires: '2020-01-01' });
    const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    appendDismissal(repoRoot, { id: 'a2', rule: 'SEC-001', reason: 'r', approved_by: 'x', expires: soon });
    const { checks, exitCode } = runDoctor(repoRoot, baseEnv());
    expect(checks.some((c) => c.status === 'warn' && c.message.includes('a1') && c.message.includes('expired'))).toBe(true);
    expect(checks.some((c) => c.status === 'warn' && c.message.includes('a2') && c.message.includes('expires soon'))).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('reports ok when no skill-set context is configured', () => {
    repoConfig();
    const { checks } = runDoctor(repoRoot, baseEnv());
    expect(checks.some((c) => c.status === 'ok' && c.message.includes('no skill-set context'))).toBe(true);
  });

  it('warns (without failing) on a configured skill missing from the skills home', () => {
    repoConfig([
      'context:',
      '  skills:',
      '    - source: superpowers',
      '      include: [ghost-skill]',
      '      reviewers: [security]',
    ].join('\n') + '\n');
    const skillsHomeDir = mkdtempSync(join(tmpdir(), 'revu-doctor-skillshome-'));
    try {
      const { checks, exitCode } = runDoctor(repoRoot, { ...baseEnv(), REVU_SKILLS_HOME: skillsHomeDir });
      const c = checks.find((x) => x.message.includes('ghost-skill'));
      expect(c).toMatchObject({ status: 'warn' });
      expect(c!.message).toContain('security');
      expect(exitCode).toBe(0);
    } finally { rmSync(skillsHomeDir, { recursive: true, force: true }); }
  });

  it('reports ok when a configured skill resolves on disk', () => {
    repoConfig([
      'context:',
      '  skills:',
      '    - source: superpowers',
      '      include: [test-driven-development]',
      '      reviewers: [security]',
    ].join('\n') + '\n');
    const skillsHomeDir = mkdtempSync(join(tmpdir(), 'revu-doctor-skillshome-'));
    mkdirSync(join(skillsHomeDir, 'superpowers', 'test-driven-development'), { recursive: true });
    writeFileSync(join(skillsHomeDir, 'superpowers', 'test-driven-development', 'SKILL.md'), 'body');
    try {
      const { checks, exitCode } = runDoctor(repoRoot, { ...baseEnv(), REVU_SKILLS_HOME: skillsHomeDir });
      expect(checks.some((c) => c.status === 'ok' && c.message.includes('resolve on disk'))).toBe(true);
      expect(exitCode).toBe(0);
    } finally { rmSync(skillsHomeDir, { recursive: true, force: true }); }
  });

  it('reports baseline size when a baseline exists', () => {
    repoConfig();
    writeBaseline(repoRoot, [{
      schema_version: 1, reviewer: 'security', status: 'FAIL', confidence: 0.9, severity: 'high',
      summary: 's', issues: [{ id: 'x1', rule: 'SEC-001', message: 'm', file: 'a.ts', line: 1, severity: 'high', confidence: 0.9 }],
    }]);
    const { checks } = runDoctor(repoRoot, baseEnv());
    expect(checks.some((c) => c.message.includes('baseline recorded: 1 finding'))).toBe(true);
  });
});

describe('doctorCommand', () => {
  it('prints one line per check and returns the exit code', () => {
    repoConfig();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = doctorCommand(repoRoot, baseEnv());
      expect(code).toBe(0);
      expect(log.mock.calls.length).toBeGreaterThan(0);
      expect(log.mock.calls.some((c) => /^\[ok\]/.test(c[0]))).toBe(true);
    } finally { log.mockRestore(); }
  });
});
