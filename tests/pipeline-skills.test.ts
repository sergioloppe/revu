import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runPipeline } from '../src/pipeline.js';
import { makeTmpRepo } from './helpers/tmprepo.js';

const SHIM = resolve('tests/fixtures/fake-claude.mjs');
let repo: ReturnType<typeof makeTmpRepo>;
let skillsHomeDir: string;
let promptDumpDir: string;

/** Two tier-1 reviewers, both matching the same rule, so both actually run. */
function setupTwoReviewerDir(root: string) {
  const rd = join(root, '.review');
  mkdirSync(join(rd, 'rules', 'security'), { recursive: true });
  mkdirSync(join(rd, 'reviewers'), { recursive: true });
  writeFileSync(join(rd, 'config.yaml'), [
    'schema_version: 1',
    'reviewers:',
    '  - id: security',
    '    tier: 1',
    '    rules: rules/security/**',
    '    min_confidence_to_block: 0.7',
    '  - id: testing',
    '    tier: 1',
    '    rules: rules/security/**',
    '    min_confidence_to_block: 0.7',
    'context:',
    '  skills:',
    '    - source: superpowers',
    '      include: [test-driven-development]',
    '      reviewers: [security]',
  ].join('\n'));
  writeFileSync(join(rd, 'rules', 'security', 'SEC-001.md'),
    '---\nid: SEC-001\ntitle: No eval\ndomain: security\nseverity: high\nblocking: true\nstatus: active\n---\n\nNever eval user input.\n');
  writeFileSync(join(rd, 'reviewers', 'security.md'),
    '---\nid: security\n---\n\nYou review changes for security only.\n');
  writeFileSync(join(rd, 'reviewers', 'testing.md'),
    '---\nid: testing\n---\n\nYou review changes for testing only.\n');
}

const env = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH!, HOME: process.env.HOME!,
  REVU_CLAUDE_BIN: SHIM, REVU_CONFIG_HOME: '/nonexistent-global',
  FAKE_CLAUDE_MODE: 'pass', REVU_SKILLS_HOME: skillsHomeDir,
  FAKE_PROMPT_DUMP_DIR: promptDumpDir, ...extra,
});

beforeEach(() => {
  repo = makeTmpRepo();
  repo.commit('src/a.ts', 'const x = 1;\n', 'base');
  setupTwoReviewerDir(repo.root);
  repo.commitAll('add review config');
  repo.branch('feature');
  repo.commit('src/a.ts', 'const x = 1;\neval(input);\n', 'introduce eval');

  skillsHomeDir = mkdtempSync(join(tmpdir(), 'revu-skillshome-'));
  mkdirSync(join(skillsHomeDir, 'superpowers', 'test-driven-development'), { recursive: true });
  writeFileSync(join(skillsHomeDir, 'superpowers', 'test-driven-development', 'SKILL.md'), 'TDD-SKILL-MARKER-V1');
  promptDumpDir = mkdtempSync(join(tmpdir(), 'revu-promptdump-'));
});
afterEach(() => {
  repo.cleanup();
  rmSync(skillsHomeDir, { recursive: true, force: true });
  rmSync(promptDumpDir, { recursive: true, force: true });
});

describe('skill-set context injection', () => {
  it('injects skill content only into the reviewer(s) listed in the config entry', async () => {
    await runPipeline(repo.root, {}, env());
    const securityPrompt = readFileSync(join(promptDumpDir, 'security.prompt.txt'), 'utf8');
    const testingPrompt = readFileSync(join(promptDumpDir, 'testing.prompt.txt'), 'utf8');
    expect(securityPrompt).toContain('TDD-SKILL-MARKER-V1');
    expect(testingPrompt).not.toContain('TDD-SKILL-MARKER-V1');
  });

  it('silently skips a configured skill missing from disk (no error, no crash)', async () => {
    rmSync(join(skillsHomeDir, 'superpowers', 'test-driven-development', 'SKILL.md'));
    const { exitCode } = await runPipeline(repo.root, {}, env());
    expect(exitCode).toBe(0); // still runs to completion (shim mode 'pass')
    const securityPrompt = readFileSync(join(promptDumpDir, 'security.prompt.txt'), 'utf8');
    expect(securityPrompt).not.toContain('TDD-SKILL-MARKER-V1');
  });

  it('changes config_hash when the skill file content changes, run to run', async () => {
    const first = await runPipeline(repo.root, {}, env());
    writeFileSync(join(skillsHomeDir, 'superpowers', 'test-driven-development', 'SKILL.md'), 'TDD-SKILL-MARKER-V2');
    const second = await runPipeline(repo.root, {}, env());
    expect(first.envelope.config_hash).not.toBe(second.envelope.config_hash);
  });

  it('config_hash is stable when the skill file content is unchanged', async () => {
    const first = await runPipeline(repo.root, {}, env());
    const second = await runPipeline(repo.root, {}, env());
    expect(first.envelope.config_hash).toBe(second.envelope.config_hash);
  });
});
