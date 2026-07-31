import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../src/gitio/repo.js';
import { computeDiff } from '../src/gitio/diff.js';
import { ToolError } from '../src/errors.js';
import { makeTmpRepo } from './helpers/tmprepo.js';

let repo: ReturnType<typeof makeTmpRepo>;
beforeEach(() => { repo = makeTmpRepo(); });
afterEach(() => repo.cleanup());

describe('findRepoRoot', () => {
  it('walks up from a nested directory to the .git root', () => {
    const nested = join(repo.root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(findRepoRoot(nested)).toBe(repo.root);
  });
  it('throws ToolError outside a repo', () => {
    expect(() => findRepoRoot('/')).toThrow(ToolError);
  });
});

describe('computeDiff', () => {
  it('diffs a feature branch against merge-base with main', () => {
    repo.commit('src/a.ts', 'export const a = 1;\n', 'base');
    repo.branch('feature');
    repo.commit('src/a.ts', 'export const a = 2;\n', 'change a');
    repo.commit('src/b.ts', 'export const b = 1;\n', 'add b');
    const diff = computeDiff(repo.root);
    expect(diff.files.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(diff.patch).toContain('+export const a = 2;');
    expect(diff.base).toMatch(/^[0-9a-f]{40}$/);
  });
  it('honors an explicit range', () => {
    repo.commit('x.ts', '1\n', 'c1');
    repo.commit('x.ts', '2\n', 'c2');
    const diff = computeDiff(repo.root, { range: 'HEAD~1...HEAD' });
    expect(diff.files).toEqual(['x.ts']);
    expect(diff.base).toMatch(/^[0-9a-f]{40}$/);
    expect(diff.base).not.toBe(diff.head);
  });
  it('throws ToolError with a hint when the diff is empty', () => {
    repo.commit('x.ts', '1\n', 'c1');
    repo.branch('feature');
    expect(() => computeDiff(repo.root)).toThrow(/--range/);
  });
  // The whole point: a credential value must never reach a reviewer prompt, and the
  // patch string is what gets compiled into one.
  it('keeps secret-bearing files out of the patch entirely', () => {
    repo.commit('a.ts', 'a\n', 'initial');
    repo.stage('.env.prestage', 'DB_PASSWORD=S3cr3tP4ssw0rd\n');
    repo.stage('.env.example', 'DB_PASSWORD=\n');
    repo.stage('tls/server.key', '-----BEGIN PRIVATE KEY-----\n');
    repo.stage('src/b.ts', 'export const b = 1;\n');

    const diff = computeDiff(repo.root, { staged: true });

    expect(diff.excluded.sort()).toEqual(['.env.prestage', 'tls/server.key']);
    expect(diff.files.sort()).toEqual(['.env.example', 'src/b.ts']);
    expect(diff.patch).not.toContain('S3cr3tP4ssw0rd');
    expect(diff.patch).not.toContain('BEGIN PRIVATE KEY');
    expect(diff.patch).not.toContain('.env.prestage');
    expect(diff.patch).toContain('.env.example'); // templates stay reviewable
  });

  it('reports an empty diff when every changed path was withheld', () => {
    repo.commit('a.ts', 'a\n', 'initial');
    repo.stage('.env', 'TOKEN=abc123\n');
    let message = '';
    try { computeDiff(repo.root, { staged: true }); } catch (err) { message = (err as Error).message; }
    expect(message).toContain('secret-bearing');
    expect(message).toContain('.env');
    expect(message).not.toContain('abc123');
  });

  it('names the mode that was diffed', () => {
    repo.commit('a.ts', 'a\n', 'initial');
    repo.stage('b.ts', 'b\n');
    expect(computeDiff(repo.root, { staged: true }).mode).toBe('staged changes');
    expect(computeDiff(repo.root, { working: true }).mode).toBe('uncommitted changes');
  });
  it('reviews staged and unstaged tracked changes under --working', () => {
    repo.commit('a.ts', 'a\n', 'initial');
    repo.stage('b.ts', 'b\n');            // staged
    writeFileSync(join(repo.root, 'a.ts'), 'a2\n'); // unstaged
    const diff = computeDiff(repo.root, { working: true });
    expect(diff.files.sort()).toEqual(['a.ts', 'b.ts']);
    expect(diff.base).toBe(diff.head);
  });

  // The reported scenario: a branch whose work is all staged, never committed. The
  // default mode is legitimately empty, and the error has to say so *and* point at
  // the flag that would review those 2 files.
  it('empty-diff error reports working-tree state and suggests the flag that fits', () => {
    repo.commit('a.ts', 'a\n', 'initial');
    repo.branch('feature');
    repo.stage('b.ts', 'b\n');
    repo.stage('c.ts', 'c\n');
    writeFileSync(join(repo.root, 'a.ts'), 'a2\n');
    writeFileSync(join(repo.root, 'untracked.ts'), 'u\n');

    let message = '';
    try { computeDiff(repo.root); } catch (err) { message = (err as Error).message; }

    expect(message).toContain('2 staged');
    expect(message).toContain('1 unstaged');
    expect(message).toContain('1 untracked');
    expect(message).toContain('revu --staged');
    expect(message).toContain('revu --working');
    expect(message).toContain('revu --help');
    expect(message).toContain('committed work only');
  });
  it('empty-diff error says so plainly when the tree is clean', () => {
    repo.commit('a.ts', 'a\n', 'initial');
    repo.branch('feature');
    let message = '';
    try { computeDiff(repo.root); } catch (err) { message = (err as Error).message; }
    expect(message).toContain('this working tree is clean');
    expect(message).not.toContain('revu --staged'); // nothing staged to suggest
  });
  it('empty-diff error under --staged does not suggest --staged again', () => {
    repo.commit('a.ts', 'a\n', 'initial');
    writeFileSync(join(repo.root, 'a.ts'), 'a2\n'); // unstaged only
    let message = '';
    try { computeDiff(repo.root, { staged: true }); } catch (err) { message = (err as Error).message; }
    expect(message).toContain('staged changes is empty');
    expect(message).not.toContain('revu --staged ');
    expect(message).toContain('revu --working');
  });
  it('returns staged changes with base === head', () => {
    repo.commit('a.ts', 'a\n', 'initial');
    repo.stage('b.ts', 'b\n');
    const diff = computeDiff(repo.root, { staged: true });
    expect(diff.files).toEqual(['b.ts']);
    expect(diff.base).toBe(diff.head);
  });
  it('filters diff by file list', () => {
    repo.commit('a.ts', 'a\n', 'initial');
    repo.branch('feature');
    repo.commit('a.ts', 'a2\n', 'change a');
    repo.commit('b.ts', 'b\n', 'add b');
    const diff = computeDiff(repo.root, { files: ['a.ts'] });
    expect(diff.files).toEqual(['a.ts']);
  });
});
