import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheKey, readCache, writeCache } from '../src/cache.js';
import type { ReviewerReport } from '../src/report/schema.js';

const REPORT: ReviewerReport = {
  schema_version: 1, reviewer: 'security', status: 'PASS',
  confidence: 0.9, severity: 'none', summary: 'looks fine', issues: [],
};

let repoRoot: string;
beforeEach(() => { repoRoot = mkdtempSync(join(tmpdir(), 'revu-cache-')); });
afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

describe('cacheKey', () => {
  it('is stable for identical inputs', () => {
    const a = cacheKey('security', 'claude-opus-4-8', 'persona\n\nrules\n\ndiff');
    const b = cacheKey('security', 'claude-opus-4-8', 'persona\n\nrules\n\ndiff');
    expect(a).toBe(b);
  });

  it('changes when the compiled prompt changes', () => {
    const a = cacheKey('security', 'm', 'prompt v1');
    const b = cacheKey('security', 'm', 'prompt v2');
    expect(a).not.toBe(b);
  });

  it('changes when the model changes', () => {
    const a = cacheKey('security', 'claude-opus-4-8', 'prompt');
    const b = cacheKey('security', 'claude-sonnet-5', 'prompt');
    expect(a).not.toBe(b);
  });

  it('changes when the reviewer id changes', () => {
    const a = cacheKey('security', 'm', 'prompt');
    const b = cacheKey('testing', 'm', 'prompt');
    expect(a).not.toBe(b);
  });

  it('changes when only the persona portion of the prompt changes', () => {
    // The key hashes the whole compiled prompt, not just rules/diff, so a persona
    // (or context-doc, or skill-content) edit — anything folded into the prompt by
    // the compiler — must also change the key.
    const a = cacheKey('security', 'm', 'PERSONA A\n\nrules\n\ndiff');
    const b = cacheKey('security', 'm', 'PERSONA B\n\nrules\n\ndiff');
    expect(a).not.toBe(b);
  });
});

describe('readCache / writeCache', () => {
  it('round-trips a written entry', () => {
    const key = cacheKey('security', 'm', 'prompt');
    expect(readCache(repoRoot, key)).toBeNull();
    writeCache(repoRoot, key, { report: REPORT, costUsd: 0.05 });
    expect(readCache(repoRoot, key)).toEqual({ report: REPORT, costUsd: 0.05 });
  });

  it('lazily creates .review/cache/reviews', () => {
    const key = cacheKey('security', 'm', 'prompt');
    expect(existsSync(join(repoRoot, '.review', 'cache', 'reviews'))).toBe(false);
    writeCache(repoRoot, key, { report: REPORT, costUsd: null });
    expect(existsSync(join(repoRoot, '.review', 'cache', 'reviews', `${key}.json`))).toBe(true);
  });

  it('treats a corrupt cache file as a miss', () => {
    const key = cacheKey('security', 'm', 'prompt');
    writeCache(repoRoot, key, { report: REPORT, costUsd: null });
    const path = join(repoRoot, '.review', 'cache', 'reviews', `${key}.json`);
    writeFileSync(path, 'not json');
    expect(readCache(repoRoot, key)).toBeNull();
  });

  it('stores costUsd null correctly', () => {
    const key = cacheKey('security', 'm', 'prompt');
    writeCache(repoRoot, key, { report: REPORT, costUsd: null });
    expect(readCache(repoRoot, key)!.costUsd).toBeNull();
    expect(readFileSync(join(repoRoot, '.review', 'cache', 'reviews', `${key}.json`), 'utf8'))
      .toContain('"costUsd": null');
  });
});
