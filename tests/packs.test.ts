import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PACKS, LANGUAGES, detectLanguage, isLanguage } from '../src/packs.js';
import { loadRules } from '../src/catalog/rules.js';
import { unmatchedRules, isLikelyMismatch } from '../src/catalog/coverage.js';
import { initCommand } from '../src/commands/init.js';
import { runDoctor } from '../src/commands/doctor.js';
import { makeTmpRepo } from './helpers/tmprepo.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'revu-pack-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('language packs', () => {
  it.each(LANGUAGES)('%s pack has a config, personas for every reviewer, and rules', (lang) => {
    const files = PACKS[lang].files;
    expect(files['config.yaml']).toBeDefined();

    const config = parseYaml(files['config.yaml']!) as { reviewers: Array<{ id: string; rules: string }> };
    for (const reviewer of config.reviewers) {
      expect(files[`reviewers/${reviewer.id}.md`], `${lang}: persona for ${reviewer.id}`).toBeDefined();
    }
    // And no persona without a reviewer to use it.
    const personaIds = Object.keys(files).filter((f) => f.startsWith('reviewers/'))
      .map((f) => f.slice('reviewers/'.length, -'.md'.length));
    expect(personaIds.sort()).toEqual(config.reviewers.map((r) => r.id).sort());

    const ruleFiles = Object.keys(files).filter((f) => f.startsWith('rules/'));
    expect(ruleFiles.length).toBeGreaterThan(0);
  });

  it.each(LANGUAGES)('%s pack rules all parse with valid frontmatter', (lang) => {
    const dir = join(root, lang);
    for (const [rel, content] of Object.entries(PACKS[lang].files)) {
      if (!rel.startsWith('rules/')) continue;
      const path = join(dir, rel);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content);
    }
    const rules = loadRules([{ dir: join(dir, 'rules'), origin: 'repo' }]);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.id, 'rule has an id').toBeTruthy();
      expect(rule.applies_to.length, `${rule.id} declares applies_to`).toBeGreaterThan(0);
      // A starter catalog is advisory until a team decides otherwise.
      expect(rule.blocking, `${rule.id} starts non-blocking`).toBe(false);
      expect(rule.status, `${rule.id} starts proposed`).toBe('proposed');
      expect(rule.body, `${rule.id} shows a violating example`).toContain('## Violating');
      expect(rule.body, `${rule.id} shows a compliant example`).toContain('## Compliant');
      expect(rule.body, `${rule.id} says how to fix`).toContain('## How to fix');
    }
    // Rule ids must be unique within a pack, or the catalog is ambiguous.
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the go pack enables tier-0 checks that need no configuration', () => {
    const config = parseYaml(PACKS.go.files['config.yaml']!) as {
      tiers: { '0': { checks: Array<{ id: string; command: string }> } };
    };
    const commands = config.tiers['0'].checks.map((c) => c.command);
    expect(commands.some((c) => c.startsWith('go build'))).toBe(true);
    expect(commands.some((c) => c.startsWith('go vet'))).toBe(true);
    expect(commands.some((c) => c.startsWith('go test'))).toBe(true);
    expect(commands.some((c) => c.includes('gofmt'))).toBe(true);
  });

  it('go rules target Go paths, not the TypeScript layout', () => {
    const globs = Object.entries(PACKS.go.files)
      .filter(([rel]) => rel.startsWith('rules/'))
      .flatMap(([, content]) => content.split('\n').filter((l) => l.trim().startsWith('- "')));
    expect(globs.some((g) => g.includes('.go'))).toBe(true);
    expect(globs.some((g) => g.includes('.ts"'))).toBe(false);
  });
});

describe('detectLanguage', () => {
  it('identifies a Go repo by go.mod', () => {
    writeFileSync(join(root, 'go.mod'), 'module example.com/x\n');
    expect(detectLanguage(root)).toBe('go');
  });
  it('identifies a TypeScript repo by package.json', () => {
    writeFileSync(join(root, 'package.json'), '{}');
    expect(detectLanguage(root)).toBe('ts');
  });
  it('returns null when nothing matches, rather than guessing', () => {
    expect(detectLanguage(root)).toBeNull();
  });
  it('returns null when several packs match, rather than picking one', () => {
    writeFileSync(join(root, 'go.mod'), 'module example.com/x\n');
    writeFileSync(join(root, 'package.json'), '{}');
    expect(detectLanguage(root)).toBeNull();
  });
  it('rejects an unknown language name', () => {
    expect(isLanguage('rust')).toBe(false);
    expect(isLanguage('go')).toBe(true);
  });
});

describe('rule coverage', () => {
  it('flags rules that match nothing in the repo', () => {
    const dir = join(root, 'rules', 'x');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'A.md'),
      '---\nid: A\ndomain: x\nstatus: active\napplies_to:\n  - "**/*.go"\n---\n\nbody\n');
    writeFileSync(join(dir, 'B.md'),
      '---\nid: B\ndomain: x\nstatus: active\napplies_to:\n  - "**/*.ts"\n---\n\nbody\n');
    const rules = loadRules([{ dir: join(root, 'rules'), origin: 'repo' }]);
    expect(unmatchedRules(rules, ['main.go'])).toEqual(['B']);
    expect(unmatchedRules(rules, ['main.go', 'a.ts'])).toEqual([]);
  });

  it('treats a majority of dead rules as a probable mismatch', () => {
    expect(isLikelyMismatch(7, 8)).toBe(true);
    expect(isLikelyMismatch(1, 10)).toBe(false);
    expect(isLikelyMismatch(0, 0)).toBe(false);
  });
});

describe('revu init language selection', () => {
  let repo: ReturnType<typeof makeTmpRepo>;
  afterEach(() => repo?.cleanup());

  function goRepo() {
    repo = makeTmpRepo();
    repo.commit('go.mod', 'module example.com/app\n\ngo 1.22\n', 'go mod');
    repo.commit('internal/storage/db.go', 'package storage\n', 'add storage');
    return repo;
  }

  it('auto-detects Go and installs the Go pack', () => {
    const r = goRepo();
    expect(initCommand(r.root, {}, {})).toBe(0);
    const config = readFileSync(join(r.root, '.review', 'config.yaml'), 'utf8');
    expect(config).toContain('go build ./...');
    expect(existsSync(join(r.root, '.review', 'rules', 'reliability', 'REL-001.md'))).toBe(true);
    expect(existsSync(join(r.root, '.review', 'reviewers', 'reliability.md'))).toBe(true);
  });

  it('--lang overrides detection', () => {
    const r = goRepo();
    expect(initCommand(r.root, { lang: 'ts' }, {})).toBe(0);
    expect(existsSync(join(r.root, '.review', 'rules', 'reliability', 'REL-001.md'))).toBe(false);
    expect(existsSync(join(r.root, '.review', 'rules', 'maintainability', 'MAINT-001.md'))).toBe(true);
  });

  it('rejects an unknown --lang without writing anything', () => {
    const r = goRepo();
    expect(initCommand(r.root, { lang: 'rust' }, {})).toBe(3);
    expect(existsSync(join(r.root, '.review', 'config.yaml'))).toBe(false);
  });

  // The failure this whole feature exists to prevent.
  it('doctor flags a TypeScript catalog scaffolded into a Go repo', () => {
    const r = goRepo();
    initCommand(r.root, { lang: 'ts' }, {});
    const { checks } = runDoctor(r.root, { REVU_CONFIG_HOME: '/nonexistent-global' });
    const coverage = checks.find((c) => c.message.includes('match no file in this repo'));
    expect(coverage).toBeDefined();
    expect(coverage!.status).not.toBe('ok');
    expect(coverage!.message).toContain('revu init --lang go');
  });

  it('doctor is quiet when the pack matches the repo', () => {
    const r = goRepo();
    initCommand(r.root, { lang: 'go' }, {});
    const { checks } = runDoctor(r.root, { REVU_CONFIG_HOME: '/nonexistent-global' });
    expect(checks.some((c) => c.status === 'fail' && c.message.includes('match no file'))).toBe(false);
  });
});
