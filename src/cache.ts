import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReviewerReport } from './report/schema.js';

export interface CacheEntry {
  report: ReviewerReport;
  costUsd: number | null;
}

/**
 * sha256(reviewer.id + model + the full compiled prompt sent to `claude`).
 *
 * Hashing the compiled prompt (rather than its individual ingredients — ruleset,
 * diff, persona, context docs, injected skill content) guarantees the key changes
 * whenever *anything* that could change the reviewer's answer changes. Hashing only
 * a subset (e.g. rules + diff) is a trap: an edit to the persona body or to injected
 * skill content silently serves a stale cached report forever, because none of those
 * inputs are reflected in the key.
 */
export function cacheKey(reviewerId: string, model: string, prompt: string): string {
  return createHash('sha256')
    .update(reviewerId).update('\0')
    .update(model).update('\0')
    .update(prompt)
    .digest('hex');
}

function cacheDir(repoRoot: string): string {
  return join(repoRoot, '.review', 'cache', 'reviews');
}

function cachePath(repoRoot: string, key: string): string {
  return join(cacheDir(repoRoot), `${key}.json`);
}

/** Missing or corrupt entries are both treated as a miss (cache is best-effort). */
export function readCache(repoRoot: string, key: string): CacheEntry | null {
  const path = cachePath(repoRoot, key);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CacheEntry;
  } catch {
    return null;
  }
}

/** Creates `.review/cache/reviews/` lazily. */
export function writeCache(repoRoot: string, key: string, entry: CacheEntry): void {
  const path = cachePath(repoRoot, key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entry, null, 2));
}
