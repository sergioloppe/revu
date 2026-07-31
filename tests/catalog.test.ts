import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules, filterRules, scanRuleCatalog, findDuplicateRuleIds } from '../src/catalog/rules.js';
import { loadReviewerPersona } from '../src/catalog/reviewers.js';
import { ConfigError } from '../src/errors.js';

let gDir: string; let rDir: string;
beforeEach(() => {
  gDir = mkdtempSync(join(tmpdir(), 'revu-grules-'));
  rDir = mkdtempSync(join(tmpdir(), 'revu-rrules-'));
});
afterEach(() => { rmSync(gDir, { recursive: true, force: true }); rmSync(rDir, { recursive: true, force: true }); });

function rule(dir: string, rel: string, fm: string, body = 'Rule body.') {
  mkdirSync(join(dir, 'rules', 'security'), { recursive: true });
  writeFileSync(join(dir, 'rules', rel), `---\n${fm}\n---\n\n${body}\n`);
}
const FM = (id: string, extra = '') =>
  `id: ${id}\ntitle: No eval\ndomain: security\nseverity: high\nblocking: true\nstatus: active${extra}`;

describe('loadRules', () => {
  it('parses frontmatter and body', () => {
    rule(rDir, 'security/SEC-001.md', FM('SEC-001'));
    const rules = loadRules([{ dir: join(rDir, 'rules'), origin: 'repo' }]);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: 'SEC-001', severity: 'high', blocking: true, origin: 'repo' });
    expect(rules[0]!.body).toContain('Rule body.');
    expect(rules[0]!.relPath).toBe('security/SEC-001.md');
  });

  it('forces global-origin rules to advisory', () => {
    rule(gDir, 'security/SEC-001.md', FM('SEC-001'));
    const rules = loadRules([{ dir: join(gDir, 'rules'), origin: 'global' }]);
    expect(rules[0]!.blocking).toBe(false);
  });

  it('repo overrides global by id, unions exceptions, and disabled removes', () => {
    rule(gDir, 'security/SEC-001.md', FM('SEC-001', '\nexceptions:\n  - "legacy/**"'));
    rule(gDir, 'security/SEC-002.md', FM('SEC-002'));
    rule(rDir, 'security/SEC-001.md', FM('SEC-001', '\nexceptions:\n  - "scripts/**"'));
    rule(rDir, 'security/SEC-002.md', 'id: SEC-002\nstatus: disabled');
    const rules = loadRules([
      { dir: join(gDir, 'rules'), origin: 'global' },
      { dir: join(rDir, 'rules'), origin: 'repo' },
    ]);
    expect(rules).toHaveLength(1);
    const merged = rules[0]!;
    expect(merged.origin).toBe('repo');
    expect(merged.blocking).toBe(true);
    expect(merged.exceptions.sort()).toEqual(['legacy/**', 'scripts/**']);
  });
});

describe('filterRules', () => {
  const base = { title: 't', domain: 'security', severity: 'high' as const, blocking: true,
    status: 'active' as const, body: '', origin: 'repo' as const, relPath: 'security/X.md' };
  it('keeps rules whose applies_to matches a changed file outside exceptions', () => {
    const rules = [
      { ...base, id: 'A', applies_to: ['src/**/*Controller.ts'], exceptions: ['src/health/**'] },
      { ...base, id: 'B', applies_to: ['docs/**'], exceptions: [] },
    ];
    const kept = filterRules(rules, ['src/orders/OrderController.ts']);
    expect(kept.map((r) => r.id)).toEqual(['A']);
  });
  it('drops a rule when every matching file is excepted', () => {
    const rules = [{ ...base, id: 'A', applies_to: ['src/**'], exceptions: ['src/health/**'] }];
    expect(filterRules(rules, ['src/health/ping.ts'])).toEqual([]);
  });
  it('defaults applies_to to everything', () => {
    const rules = [{ ...base, id: 'A', applies_to: ['**'], exceptions: [] }];
    expect(filterRules(rules, ['anything.md'])).toHaveLength(1);
  });
});

describe('scanRuleCatalog', () => {
  it('lists every file as its own entry, without merging by id', () => {
    rule(gDir, 'security/SEC-001.md', FM('SEC-001'));
    rule(rDir, 'security/SEC-001.md', FM('SEC-001'));
    const { entries, errors } = scanRuleCatalog([
      { dir: join(gDir, 'rules'), origin: 'global' },
      { dir: join(rDir, 'rules'), origin: 'repo' },
    ]);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.origin).sort()).toEqual(['global', 'repo']);
    expect(entries[0]).toMatchObject({ id: 'SEC-001', domain: 'security', blocking: true, status: 'active' });
  });

  it('collects a frontmatter error per invalid file instead of throwing', () => {
    mkdirSync(join(rDir, 'rules', 'security'), { recursive: true });
    writeFileSync(join(rDir, 'rules', 'security', 'BAD.md'), '---\ntitle: no id\n---\n\nbody\n');
    const { entries, errors } = scanRuleCatalog([{ dir: join(rDir, 'rules'), origin: 'repo' }]);
    expect(entries).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.file).toContain('BAD.md');
  });
});

describe('findDuplicateRuleIds', () => {
  it('flags two files in the SAME layer declaring the same id', () => {
    rule(rDir, 'security/SEC-001.md', FM('SEC-001'));
    mkdirSync(join(rDir, 'rules', 'security2'), { recursive: true });
    writeFileSync(join(rDir, 'rules', 'security2', 'DUP.md'), `---\n${FM('SEC-001')}\n---\n\nbody\n`);
    const { entries } = scanRuleCatalog([{ dir: join(rDir, 'rules'), origin: 'repo' }]);
    const dups = findDuplicateRuleIds(entries);
    expect(dups).toHaveLength(1);
    expect(dups[0]!.id).toBe('SEC-001');
    expect(dups[0]!.files).toHaveLength(2);
  });

  it('does not flag the same id across different layers (intentional override)', () => {
    rule(gDir, 'security/SEC-001.md', FM('SEC-001'));
    rule(rDir, 'security/SEC-001.md', FM('SEC-001'));
    const { entries } = scanRuleCatalog([
      { dir: join(gDir, 'rules'), origin: 'global' },
      { dir: join(rDir, 'rules'), origin: 'repo' },
    ]);
    expect(findDuplicateRuleIds(entries)).toEqual([]);
  });
});

describe('loadReviewerPersona', () => {
  it('later source wins', () => {
    for (const [d, text] of [[gDir, 'GLOBAL PERSONA'], [rDir, 'REPO PERSONA']] as const) {
      mkdirSync(join(d, 'reviewers'), { recursive: true });
      writeFileSync(join(d, 'reviewers', 'security.md'), `---\nid: security\n---\n\n${text}\n`);
    }
    const p = loadReviewerPersona([{ dir: gDir }, { dir: rDir }], 'security');
    expect(p.body).toContain('REPO PERSONA');
  });
  it('throws ConfigError when missing', () => {
    expect(() => loadReviewerPersona([{ dir: rDir }], 'nope')).toThrow(ConfigError);
  });
});
