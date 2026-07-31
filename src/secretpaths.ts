import picomatch from 'picomatch';
import { GENERATED_PATH_DENY, SECRET_PATH_ALLOW, SECRET_PATH_DENY } from './constants.js';

// `dot: true`: most patterns here target dotfiles, which picomatch otherwise skips.
const denies = picomatch([...SECRET_PATH_DENY], { dot: true });
const allows = picomatch([...SECRET_PATH_ALLOW], { dot: true });
const generated = picomatch([...GENERATED_PATH_DENY], { dot: true });

/**
 * True when a repo-relative path holds credential values, so its content must never
 * reach a reviewer prompt. `.env.example` and friends are exempt (see SECRET_PATH_ALLOW).
 */
export function isSecretPath(relPath: string): boolean {
  return denies(relPath) && !allows(relPath);
}

/** True for revu's own generated output — nothing to review, and it echoes findings back. */
export function isGeneratedPath(relPath: string): boolean {
  return generated(relPath);
}

/** Paths withheld from review: credential files plus revu's own artifacts. */
export function isWithheldPath(relPath: string): boolean {
  return isSecretPath(relPath) || isGeneratedPath(relPath);
}

export function partitionWithheldPaths(files: string[]): { kept: string[]; excluded: string[] } {
  const kept: string[] = [];
  const excluded: string[] = [];
  for (const f of files) (isWithheldPath(f) ? excluded : kept).push(f);
  return { kept, excluded };
}
