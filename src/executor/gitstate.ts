import { createHash } from 'node:crypto';
import { git } from '../gitio/repo.js';
import { SecurityViolationError } from '../errors.js';

export interface GitState { head: string; statusHash: string }

export function snapshotGitState(root: string): GitState {
  const head = git(root, ['rev-parse', 'HEAD']);
  const status = git(root, ['status', '--porcelain']);
  return { head, statusHash: createHash('sha256').update(status).digest('hex') };
}

export function verifyGitState(root: string, before: GitState, reviewerId: string): void {
  const after = snapshotGitState(root);
  if (after.head !== before.head) {
    throw new SecurityViolationError(reviewerId, `HEAD moved from ${before.head} to ${after.head}.`);
  }
  if (after.statusHash !== before.statusHash) {
    throw new SecurityViolationError(reviewerId, 'working tree or index contents changed during review.');
  }
}
