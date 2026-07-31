import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { detectAuthMode, preflight } from '../src/executor/preflight.js';
import { snapshotGitState, verifyGitState } from '../src/executor/gitstate.js';
import { ToolError, SecurityViolationError } from '../src/errors.js';
import { makeTmpRepo } from './helpers/tmprepo.js';

const SHIM = resolve('tests/fixtures/fake-claude.mjs');

describe('preflight', () => {
  it('detects api_key mode from the environment', () => {
    expect(detectAuthMode({ ANTHROPIC_API_KEY: 'sk-x' })).toBe('api_key');
    expect(detectAuthMode({})).toBe('subscription');
  });
  it('passes when the claude binary responds to --version', () => {
    expect(preflight(SHIM, {})).toEqual({ authMode: 'subscription' });
  });
  it('throws ToolError when the binary is missing', () => {
    expect(() => preflight('/nonexistent/claude', {})).toThrow(ToolError);
  });
});

describe('git-state assertion', () => {
  let repo: ReturnType<typeof makeTmpRepo>;
  beforeEach(() => { repo = makeTmpRepo(); repo.commit('a.ts', 'const a = 1;\n', 'base'); });
  afterEach(() => repo.cleanup());

  it('passes when nothing changed', () => {
    const before = snapshotGitState(repo.root);
    expect(() => verifyGitState(repo.root, before, 'security')).not.toThrow();
  });
  it('throws SecurityViolationError naming the reviewer on worktree mutation', () => {
    const before = snapshotGitState(repo.root);
    writeFileSync(join(repo.root, 'evil.ts'), 'hacked\n');
    expect(() => verifyGitState(repo.root, before, 'security'))
      .toThrow(SecurityViolationError);
    expect(() => verifyGitState(repo.root, before, 'security')).toThrow(/security/);
  });
  it('throws on a new commit (HEAD moved)', () => {
    const before = snapshotGitState(repo.root);
    repo.commit('a.ts', 'const a = 2;\n', 'sneaky commit');
    expect(() => verifyGitState(repo.root, before, 'security')).toThrow(SecurityViolationError);
  });
});
