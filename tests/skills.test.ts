import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSkillsForReviewer, findMissingSkills, skillsHome } from '../src/skills.js';
import type { SkillContextEntry } from '../src/config/schema.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'revu-skills-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function writeSkill(root: string, rel: string, content: string) {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
}

describe('skillsHome', () => {
  it('defaults to ~/.claude/skills', () => {
    expect(skillsHome({})).toMatch(/\.claude[/\\]skills$/);
  });
  it('honors REVU_SKILLS_HOME', () => {
    expect(skillsHome({ REVU_SKILLS_HOME: '/custom/skills' })).toBe('/custom/skills');
  });
});

describe('resolveSkillsForReviewer', () => {
  const env = (h: string) => ({ REVU_SKILLS_HOME: h });

  it('resolves <home>/<source>/<name>/SKILL.md', () => {
    writeSkill(home, 'superpowers/test-driven-development', 'TDD-MARKER');
    const entries: SkillContextEntry[] = [
      { source: 'superpowers', include: ['test-driven-development'], reviewers: ['testing'] },
    ];
    const resolved = resolveSkillsForReviewer(entries, 'testing', env(home));
    expect(resolved).toEqual([{ source: 'superpowers', name: 'test-driven-development', content: 'TDD-MARKER' }]);
  });

  it('falls back to <home>/<name>/SKILL.md when the sourced path is absent', () => {
    writeSkill(home, 'my-skill', 'FALLBACK-MARKER');
    const entries: SkillContextEntry[] = [
      { source: 'nonexistent-source', include: ['my-skill'], reviewers: ['testing'] },
    ];
    const resolved = resolveSkillsForReviewer(entries, 'testing', env(home));
    expect(resolved).toEqual([{ source: 'nonexistent-source', name: 'my-skill', content: 'FALLBACK-MARKER' }]);
  });

  it('skips a skill missing from disk entirely, without throwing', () => {
    const entries: SkillContextEntry[] = [
      { source: 'superpowers', include: ['does-not-exist'], reviewers: ['testing'] },
    ];
    expect(resolveSkillsForReviewer(entries, 'testing', env(home))).toEqual([]);
  });

  it('only resolves skills for reviewers listed in the entry', () => {
    writeSkill(home, 'superpowers/test-driven-development', 'TDD-MARKER');
    const entries: SkillContextEntry[] = [
      { source: 'superpowers', include: ['test-driven-development'], reviewers: ['testing'] },
    ];
    expect(resolveSkillsForReviewer(entries, 'security', env(home))).toEqual([]);
  });

  it('resolves multiple skills across multiple entries, in order', () => {
    writeSkill(home, 'superpowers/test-driven-development', 'TDD-MARKER');
    writeSkill(home, 'superpowers/systematic-debugging', 'DEBUG-MARKER');
    const entries: SkillContextEntry[] = [
      { source: 'superpowers', include: ['test-driven-development', 'systematic-debugging'], reviewers: ['testing'] },
    ];
    const resolved = resolveSkillsForReviewer(entries, 'testing', env(home));
    expect(resolved.map((r) => r.name)).toEqual(['test-driven-development', 'systematic-debugging']);
  });
});

describe('findMissingSkills', () => {
  it('reports skills that fail to resolve, with their configured reviewers', () => {
    writeSkill(home, 'superpowers/test-driven-development', 'TDD-MARKER');
    const entries: SkillContextEntry[] = [
      { source: 'superpowers', include: ['test-driven-development', 'ghost-skill'], reviewers: ['testing', 'security'] },
    ];
    const missing = findMissingSkills(entries, { REVU_SKILLS_HOME: home });
    expect(missing).toEqual([{ source: 'superpowers', name: 'ghost-skill', reviewers: ['testing', 'security'] }]);
  });

  it('returns empty when everything configured resolves', () => {
    writeSkill(home, 'superpowers/test-driven-development', 'TDD-MARKER');
    const entries: SkillContextEntry[] = [
      { source: 'superpowers', include: ['test-driven-development'], reviewers: ['testing'] },
    ];
    expect(findMissingSkills(entries, { REVU_SKILLS_HOME: home })).toEqual([]);
  });
});
