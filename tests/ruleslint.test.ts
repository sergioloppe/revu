import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rulesLintCommand } from '../src/commands/ruleslint.js';

let repoRoot: string; let globalDir: string;
const env = () => ({ REVU_CONFIG_HOME: globalDir });

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'revu-lint-repo-'));
  globalDir = mkdtempSync(join(tmpdir(), 'revu-lint-global-'));
});
afterEach(() => { rmSync(repoRoot, { recursive: true, force: true }); rmSync(globalDir, { recursive: true, force: true }); });

function repoRule(rel: string, fm: string, body = 'Body.') {
  const path = join(repoRoot, '.review', 'rules', rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `---\n${fm}\n---\n\n${body}\n`);
}
const FM = (id: string) => `id: ${id}\ndomain: security\nseverity: high\nblocking: false\nstatus: active`;

describe('rulesLintCommand', () => {
  it('exits 0 and reports ok when the catalog is clean', () => {
    repoRule('security/SEC-001.md', FM('SEC-001'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(rulesLintCommand(repoRoot, env())).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toMatch(/1 rule\(s\) ok/);
    } finally { log.mockRestore(); }
  });

  it('exits 3 and reports invalid frontmatter', () => {
    const path = join(repoRoot, '.review', 'rules', 'security', 'BAD.md');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '---\ntitle: missing id\n---\n\nbody\n');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(rulesLintCommand(repoRoot, env())).toBe(3);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('invalid frontmatter');
    } finally { errSpy.mockRestore(); }
  });

  it('exits 3 and reports a duplicate rule id within the repo layer', () => {
    repoRule('security/SEC-001.md', FM('SEC-001'));
    repoRule('security2/OTHER.md', FM('SEC-001'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(rulesLintCommand(repoRoot, env())).toBe(3);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('duplicate rule id "SEC-001"');
    } finally { errSpy.mockRestore(); }
  });

  it('does not flag a repo rule overriding a global rule of the same id', () => {
    // The cascade only activates the global layer once a global config.yaml exists.
    writeFileSync(join(globalDir, 'config.yaml'), 'schema_version: 1\n');
    const gPath = join(globalDir, 'rules', 'security', 'SEC-001.md');
    mkdirSync(join(gPath, '..'), { recursive: true });
    writeFileSync(gPath, `---\n${FM('SEC-001')}\n---\n\nGlobal body.\n`);
    repoRule('security/SEC-001.md', FM('SEC-001'));
    expect(rulesLintCommand(repoRoot, env())).toBe(0);
  });
});
