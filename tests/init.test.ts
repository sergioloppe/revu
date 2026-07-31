import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initCommand } from '../src/commands/init.js';
import { loadEffectiveConfig } from '../src/config/cascade.js';
import { loadRules } from '../src/catalog/rules.js';
import { makeTmpRepo } from './helpers/tmprepo.js';

let repo: ReturnType<typeof makeTmpRepo>;
let globalDir: string;
beforeEach(() => {
  repo = makeTmpRepo();
  repo.commit('README.md', 'hi\n', 'init');
  globalDir = join(mkdtempSync(join(tmpdir(), 'revu-ginit-')), 'revu');
});
afterEach(() => { repo.cleanup(); rmSync(globalDir, { recursive: true, force: true }); });

describe('initCommand', () => {
  const PERSONAS = ['architecture', 'security', 'testing', 'company-standards',
    'performance', 'maintainability', 'documentation'];

  it('scaffolds a working .review/ catalog with the full seven-reviewer committee', () => {
    const code = initCommand(repo.root, {}, {});
    expect(code).toBe(0);
    for (const id of PERSONAS) {
      expect(existsSync(join(repo.root, '.review', 'reviewers', `${id}.md`)), id).toBe(true);
    }
    for (const rel of ['config.yaml', 'rules/security/SEC-001.md', 'rules/security/SEC-002.md',
      'schema/report.schema.json']) {
      expect(existsSync(join(repo.root, '.review', rel)), rel).toBe(true);
    }
    // the scaffold parses end-to-end
    const loaded = loadEffectiveConfig(repo.root, { REVU_CONFIG_HOME: '/nonexistent' });
    expect(loaded.config.reviewers.map((r) => r.id).sort()).toEqual([...PERSONAS].sort());
    const byId = new Map(loaded.config.reviewers.map((r) => [r.id, r]));
    // tier 1 = blocking committee, tier 2 = advisory (design §3.1)
    expect(byId.get('architecture')!.tier).toBe(1);
    expect(byId.get('security')!.tier).toBe(1);
    expect(byId.get('testing')!.tier).toBe(1);
    expect(byId.get('company-standards')!.tier).toBe(1);
    expect(byId.get('performance')!.tier).toBe(2);
    expect(byId.get('maintainability')!.tier).toBe(2);
    expect(byId.get('documentation')!.tier).toBe(2);
    // model overrides per design §3.1
    expect(byId.get('security')!.model).toBe('claude-opus-4-8');
    expect(byId.get('security')!.min_confidence_to_block).toBe(0.70);
    expect(byId.get('company-standards')!.model).toBe('claude-haiku-4-5');
    expect(byId.get('company-standards')!.min_confidence_to_block).toBe(0.90);
    expect(byId.get('maintainability')!.model).toBe('claude-haiku-4-5');
    expect(byId.get('documentation')!.model).toBe('claude-haiku-4-5');
    // default model applies where not overridden
    expect(byId.get('architecture')!.model).toBe('claude-sonnet-5');
    expect(byId.get('testing')!.model).toBe('claude-sonnet-5');
    expect(byId.get('performance')!.model).toBe('claude-sonnet-5');
    expect(loaded.config.defaults.model).toBe('claude-sonnet-5');

    const rules = loadRules([{ dir: join(repo.root, '.review', 'rules'), origin: 'repo' }]);
    // at least one starter rule per domain, all parse successfully
    const domains = new Set(rules.map((r) => r.domain));
    for (const id of PERSONAS) expect(domains, id).toContain(id);
    // starter rules are advisory: nothing blocks out of the box
    expect(rules.every((r) => !r.blocking)).toBe(true);
    expect(rules.every((r) => r.status === 'proposed')).toBe(true);
    expect(JSON.parse(readFileSync(join(repo.root, '.review', 'schema', 'report.schema.json'), 'utf8')))
      .toHaveProperty('properties.schema_version');
  });

  it('writes a .review/.gitignore that excludes the review cache', () => {
    expect(initCommand(repo.root, {}, {})).toBe(0);
    const gitignorePath = join(repo.root, '.review', '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
    expect(readFileSync(gitignorePath, 'utf8')).toContain('cache/');
  });

  it('refuses to overwrite an existing catalog', () => {
    expect(initCommand(repo.root, {}, {})).toBe(0);
    expect(initCommand(repo.root, {}, {})).toBe(3);
  });

  it('scaffolds the global dir with --global', () => {
    const code = initCommand(repo.root, { global: true }, { REVU_CONFIG_HOME: globalDir });
    expect(code).toBe(0);
    expect(existsSync(join(globalDir, 'config.yaml'))).toBe(true);
  });

  it('writes lefthook.yml at the repo root, but not with --global', () => {
    expect(initCommand(repo.root, {}, {})).toBe(0);
    const lefthookPath = join(repo.root, 'lefthook.yml');
    expect(existsSync(lefthookPath)).toBe(true);
    expect(readFileSync(lefthookPath, 'utf8')).toContain('revu --tier 1 --format pretty');
    expect(readFileSync(lefthookPath, 'utf8')).toContain('--no-verify');

    const globalRepo = makeTmpRepo();
    globalRepo.commit('README.md', 'hi\n', 'init');
    try {
      expect(initCommand(globalRepo.root, { global: true }, { REVU_CONFIG_HOME: globalDir })).toBe(0);
      expect(existsSync(join(globalRepo.root, 'lefthook.yml'))).toBe(false);
    } finally {
      globalRepo.cleanup();
    }
  });

  it('never overwrites an existing lefthook.yml', () => {
    writeFileSync(join(repo.root, 'lefthook.yml'), 'custom: true\n');
    expect(initCommand(repo.root, {}, {})).toBe(0);
    expect(readFileSync(join(repo.root, 'lefthook.yml'), 'utf8')).toBe('custom: true\n');
  });
});

describe('initCommand --claude', () => {
  const CLAUDE_FILES = ['revu.md', 'revu-rule.md', 'revu-triage.md'];

  it('writes the three Claude Code command files', () => {
    const code = initCommand(repo.root, { claude: true }, {});
    expect(code).toBe(0);
    for (const rel of CLAUDE_FILES) {
      const path = join(repo.root, '.claude', 'commands', rel);
      expect(existsSync(path), rel).toBe(true);
      expect(readFileSync(path, 'utf8').length).toBeGreaterThan(0);
    }
  });

  it('also writes the ordinary .review/ catalog (--claude is additive)', () => {
    expect(initCommand(repo.root, { claude: true }, {})).toBe(0);
    expect(existsSync(join(repo.root, '.review', 'config.yaml'))).toBe(true);
  });

  it('refuses to overwrite an existing Claude command file, writing none of the three', () => {
    const commandsDir = join(repo.root, '.claude', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, 'revu.md'), 'custom content\n');
    const code = initCommand(repo.root, { claude: true }, {});
    expect(code).toBe(3);
    expect(readFileSync(join(commandsDir, 'revu.md'), 'utf8')).toBe('custom content\n');
    expect(existsSync(join(commandsDir, 'revu-rule.md'))).toBe(false);
    expect(existsSync(join(commandsDir, 'revu-triage.md'))).toBe(false);
  });
});
