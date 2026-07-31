import { git } from './repo.js';
import { ToolError } from '../errors.js';
import { partitionWithheldPaths } from '../secretpaths.js';

export interface Diff {
  base: string;
  head: string;
  patch: string;
  files: string[];
  /** Human label for what was diffed, e.g. "staged changes". Used in progress output. */
  mode: string;
  /**
   * Changed paths withheld from review: credential files (SECRET_PATH_DENY) and
   * revu's own generated output (GENERATED_PATH_DENY).
   */
  excluded: string[];
}

export interface DiffOpts {
  staged?: boolean;
  /** All uncommitted changes to tracked files (staged + unstaged), i.e. `git diff HEAD`. */
  working?: boolean;
  range?: string;
  files?: string[];
}

function resolveBase(root: string): string {
  for (const ref of ['origin/main', 'main']) {
    try { return git(root, ['merge-base', ref, 'HEAD']); } catch { /* try next */ }
  }
  throw new ToolError('cannot resolve a merge base (no origin/main or main); use --range <a>...<b>');
}

function countLines(root: string, args: string[]): number {
  try {
    return git(root, args).split('\n').filter((s) => s.trim()).length;
  } catch {
    return 0;
  }
}

/**
 * Builds the message for "the selected diff was empty".
 *
 * The old message ("empty diff — nothing to review") named two flags and left the
 * user to guess which applied. The common case is a branch whose changes are all
 * uncommitted: the default mode diffs committed history against the merge base,
 * finds nothing, and says nothing about the 106 staged files sitting right there.
 * So: report what the working tree actually holds, and list only the commands that
 * would review something.
 */
function emptyDiffMessage(
  root: string, opts: DiffOpts, mode: string, base: string, excluded: string[] = [],
): string {
  const staged = countLines(root, ['diff', '--cached', '--name-only']);
  const unstaged = countLines(root, ['diff', '--name-only']);
  const untracked = countLines(root, ['ls-files', '--others', '--exclude-standard']);
  const uncommitted = countLines(root, ['diff', 'HEAD', '--name-only']);

  const lines = [`nothing to review — ${mode} is empty.`];
  if (!opts.staged && !opts.working && !opts.range) {
    lines.push(`  (the default mode reviews committed work only: ${base.slice(0, 7)}..HEAD)`);
  }
  if (opts.files?.length) {
    lines.push(`  (--files narrowed the diff to: ${opts.files.join(', ')})`);
  }
  if (excluded.length) {
    lines.push(`  (${excluded.length} path(s) are never reviewed — secret-bearing or revu-generated: ${excluded.join(', ')})`);
  }

  const state: string[] = [];
  if (staged) state.push(`${staged} staged`);
  if (unstaged) state.push(`${unstaged} unstaged`);
  if (untracked) state.push(`${untracked} untracked`);
  lines.push('', state.length
    ? `this working tree has ${state.join(', ')} file(s).`
    : 'this working tree is clean.');

  const suggestions: string[] = [];
  if (staged && !opts.staged) {
    suggestions.push(`  revu --staged                  review the ${staged} staged file(s)`);
  }
  if (uncommitted && !opts.working) {
    suggestions.push(`  revu --working                 review all ${uncommitted} uncommitted change(s)`);
  }
  suggestions.push('  revu --range main...HEAD       review this branch against another ref');
  suggestions.push('  revu --files <path>...         review specific files');
  suggestions.push('  revu --help                    all options');
  lines.push('', 'try one of:', ...suggestions);

  if (untracked && !staged) {
    lines.push('', 'note: untracked files are never in a diff — `git add` them first.');
  }
  return lines.join('\n');
}

export function computeDiff(root: string, opts: DiffOpts = {}): Diff {
  let head = git(root, ['rev-parse', 'HEAD']);
  let base = head;
  let diffArgs: string[];
  let mode: string;
  if (opts.staged) {
    // base === head is semantically correct for staged mode (index vs HEAD)
    diffArgs = ['diff', '--cached'];
    mode = 'staged changes';
  } else if (opts.working) {
    // Staged + unstaged changes to tracked files. base === head for the same reason.
    diffArgs = ['diff', 'HEAD'];
    mode = 'uncommitted changes';
  } else if (opts.range) {
    mode = `range ${opts.range}`;
    if (opts.range.includes('...')) {
      const [a, b = 'HEAD'] = opts.range.split('...');
      base = git(root, ['merge-base', a.trim(), b.trim()]);
      head = git(root, ['rev-parse', b.trim()]);
      diffArgs = ['diff', opts.range];
    } else if (opts.range.includes('..')) {
      const [a, b = 'HEAD'] = opts.range.split('..');
      base = git(root, ['rev-parse', a.trim()]);
      head = git(root, ['rev-parse', b.trim()]);
      diffArgs = ['diff', opts.range];
    } else {
      base = git(root, ['rev-parse', opts.range]);
      diffArgs = ['diff', opts.range];
    }
  } else {
    base = resolveBase(root);
    diffArgs = ['diff', `${base}..HEAD`];
    mode = 'branch commits vs merge base';
  }
  let pathspecStarted = false;
  if (opts.files?.length) { diffArgs.push('--', ...opts.files); pathspecStarted = true; }

  const nameOnly = (args: string[]) =>
    git(root, [...args.slice(0, 1), '--name-only', ...args.slice(1)])
      .split('\n').map((f) => f.trim()).filter(Boolean);

  // Secret-bearing paths are dropped via git pathspecs rather than filtered out of the
  // patch text afterwards: the content must never be produced at all, since anything
  // that reaches this process can end up in a prompt, a cache entry, or the report.
  const { excluded } = partitionWithheldPaths(nameOnly(diffArgs));
  if (excluded.length > 0) {
    if (!pathspecStarted) diffArgs.push('--');
    // `literal` magic: the path is taken verbatim, never re-interpreted as a glob.
    diffArgs.push(...excluded.map((f) => `:(exclude,literal)${f}`));
  }

  const patch = git(root, diffArgs);
  const files = nameOnly(diffArgs);
  if (!patch || files.length === 0) {
    throw new ToolError(emptyDiffMessage(root, opts, mode, base, excluded));
  }
  return { base, head, patch, files, mode, excluded };
}
