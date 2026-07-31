import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The version reported by `revu --version` and stamped into every envelope, read
 * from package.json at startup.
 *
 * Single-sourcing it there means `npm version patch|minor|major` is the entire
 * release step — previously the number also lived in src/constants.ts, so a bump
 * that missed it shipped envelopes labelled with the wrong version.
 *
 * Both layouts resolve with the same relative path: src/version.ts and
 * dist/version.js each sit one directory below the package root.
 */
function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(join(here, rel), 'utf8')) as
        { name?: string; version?: string };
      if (pkg.name === 'revu' && typeof pkg.version === 'string') return pkg.version;
    } catch { /* try next candidate */ }
  }
  return '0.0.0-unknown';
}

export const REVU_VERSION = readVersion();
