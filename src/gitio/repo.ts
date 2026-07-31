import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ToolError } from '../errors.js';

export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new ToolError(`no git repository found above ${startDir}`);
    dir = parent;
  }
}

export function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const e = err as Error & { stderr?: Buffer | string };
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    throw new ToolError(`git ${args.join(' ')} failed: ${e.message}${stderr ? `\n${stderr}` : ''}`);
  }
}
