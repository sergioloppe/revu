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
import { LARAVEL_CONFIG_YAML, LARAVEL_RULES } from '../src/templates-laravel.js';

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

  it('the laravel pack ships tier-0 checks that survive a missing Pint', () => {
    const config = parseYaml(LARAVEL_CONFIG_YAML) as {
      tiers: { '0': { checks: Array<{ id: string; command: string }> } };
    };
    const commands = config.tiers['0'].checks.map((c) => c.command);
    expect(commands.some((c) => c.startsWith('composer validate'))).toBe(true);
    expect(commands.some((c) => c.startsWith('php artisan test'))).toBe(true);
    // Pint is guarded: an absent binary must skip, not fail the whole run at tier 0
    // before a single reviewer starts.
    const pint = commands.find((c) => c.includes('pint'));
    expect(pint).toContain('[ -x vendor/bin/pint ]');
    expect(pint).toContain('||');
    // Larastan is never present unless deliberately installed, so it ships commented out.
    expect(commands.some((c) => c.includes('phpstan'))).toBe(false);
  });

  it('the laravel pack puts eloquent on the blocking tier', () => {
    const config = parseYaml(LARAVEL_CONFIG_YAML) as {
      reviewers: Array<{ id: string; tier: number }>;
    };
    const eloquent = config.reviewers.find((r) => r.id === 'eloquent');
    expect(eloquent, 'eloquent reviewer exists').toBeDefined();
    // Tier 2 is advisory and can never block; N+1 is the defect this pack exists for.
    expect(eloquent!.tier, 'N+1 must be able to block').toBe(1);
    expect(config.reviewers.some((r) => r.id === 'maintainability')).toBe(false);
  });

  it('the laravel catalog covers every reviewer and targets Laravel paths', () => {
    const ids = Object.values(LARAVEL_RULES).map((c) => /^id:\s*(\S+)$/m.exec(c)?.[1]);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);

    // One rule per reviewer domain at minimum, or that reviewer is skipped at runtime
    // for lack of applicable rules and the run reports PASS without reviewing anything.
    for (const domain of ['security', 'eloquent', 'architecture', 'testing',
      'performance', 'company-standards', 'documentation']) {
      expect(Object.keys(LARAVEL_RULES).some((k) => k.startsWith(`rules/${domain}/`)),
        `${domain} has a rule`).toBe(true);
    }

    const globs = Object.values(LARAVEL_RULES)
      .flatMap((c) => c.split('\n').filter((l) => l.trim().startsWith('- "')));
    expect(globs.some((g) => g.includes('.php"'))).toBe(true);
    expect(globs.some((g) => g.includes('blade.php"'))).toBe(true);
    expect(globs.some((g) => g.includes('.ts"')), 'no TypeScript layout').toBe(false);
    expect(globs.some((g) => g.includes('.go"')), 'no Go layout').toBe(false);
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
  it('identifies a Laravel repo by artisan', () => {
    writeFileSync(join(root, 'artisan'), '#!/usr/bin/env php\n');
    expect(detectLanguage(root)).toBe('laravel');
  });

  // Every modern Laravel app ships package.json for Vite/Tailwind. Without precedence
  // this is ambiguous, detection returns null, and init silently installs the TS pack —
  // a catalog that matches nothing, so every reviewer is skipped and the run says PASS.
  it('prefers laravel over ts when a Laravel app also has package.json', () => {
    writeFileSync(join(root, 'artisan'), '#!/usr/bin/env php\n');
    writeFileSync(join(root, 'package.json'), '{}');
    expect(detectLanguage(root)).toBe('laravel');
  });

  it('rejects an unknown language name', () => {
    expect(isLanguage('rust')).toBe(false);
    expect(isLanguage('go')).toBe(true);
    expect(isLanguage('laravel')).toBe(true);
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

  function laravelRepo() {
    repo = makeTmpRepo();
    repo.commit('artisan', '#!/usr/bin/env php\n', 'laravel skeleton');
    repo.commit('package.json', '{}', 'vite');
    repo.commit('app/Models/Post.php', '<?php\n\nclass Post {}\n', 'add model');
    repo.commit('app/Http/Controllers/PostController.php', '<?php\n\nclass PostController {}\n', 'add controller');
    repo.commit('app/Http/Requests/StorePostRequest.php', '<?php\n', 'add request');
    repo.commit('app/Jobs/SyncInventory.php', '<?php\n', 'add job');
    repo.commit('config/services.php', '<?php\n\nreturn [];\n', 'add config');
    repo.commit('routes/web.php', '<?php\n', 'add routes');
    repo.commit('database/migrations/2026_01_01_000000_create_posts_table.php', '<?php\n', 'add migration');
    repo.commit('resources/views/posts/index.blade.php', '<div></div>\n', 'add view');
    repo.commit('tests/Feature/PostTest.php', '<?php\n', 'add test');
    return repo;
  }

  it('auto-detects Laravel despite package.json, and installs the Laravel pack', () => {
    const r = laravelRepo();
    expect(initCommand(r.root, {}, {})).toBe(0);
    const config = readFileSync(join(r.root, '.review', 'config.yaml'), 'utf8');
    expect(config).toContain('php artisan test');
    expect(existsSync(join(r.root, '.review', 'rules', 'eloquent', 'ELO-001.md'))).toBe(true);
    expect(existsSync(join(r.root, '.review', 'reviewers', 'eloquent.md'))).toBe(true);
    expect(existsSync(join(r.root, '.review', 'reviewers', 'maintainability.md'))).toBe(false);
  });

  it('doctor is quiet when the laravel pack matches the repo', () => {
    const r = laravelRepo();
    initCommand(r.root, { lang: 'laravel' }, {});
    const { checks } = runDoctor(r.root, { REVU_CONFIG_HOME: '/nonexistent-global' });
    expect(checks.some((c) => c.status === 'fail' && c.message.includes('match no file'))).toBe(false);
  });

  it('doctor flags a TypeScript catalog scaffolded into a Laravel repo', () => {
    const r = laravelRepo();
    initCommand(r.root, { lang: 'ts' }, {});
    const { checks } = runDoctor(r.root, { REVU_CONFIG_HOME: '/nonexistent-global' });
    const coverage = checks.find((c) => c.message.includes('match no file in this repo'));
    expect(coverage).toBeDefined();
    expect(coverage!.message).toContain('revu init --lang laravel');
  });

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
