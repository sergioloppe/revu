import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillContextEntry } from './config/schema.js';

/** `$REVU_SKILLS_HOME`, falling back to the standard Claude Code skills directory. */
export function skillsHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.REVU_SKILLS_HOME ?? join(homedir(), '.claude', 'skills');
}

/**
 * Resolves a skill's `SKILL.md` on disk: `<home>/<source>/<name>/SKILL.md` first,
 * falling back to `<home>/<name>/SKILL.md` (design §5.3). Returns null if neither
 * exists — callers decide what "missing" means (silent skip at run time, a doctor
 * warning, etc).
 */
function resolveSkillPath(home: string, source: string, name: string): string | null {
  const sourced = join(home, source, name, 'SKILL.md');
  if (existsSync(sourced)) return sourced;
  const fallback = join(home, name, 'SKILL.md');
  if (existsSync(fallback)) return fallback;
  return null;
}

export interface ResolvedSkill { source: string; name: string; content: string }

/**
 * Resolves every skill configured (via `context.skills`) for `reviewerId`, in
 * `include` order within each entry, entries in config order. Skills whose
 * `SKILL.md` isn't found on disk are skipped silently — a missing skill never
 * fails a run; `revu doctor` is where drift gets surfaced (design §5.3).
 */
export function resolveSkillsForReviewer(
  entries: SkillContextEntry[],
  reviewerId: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSkill[] {
  const home = skillsHome(env);
  const resolved: ResolvedSkill[] = [];
  for (const entry of entries) {
    if (!entry.reviewers.includes(reviewerId)) continue;
    for (const name of entry.include) {
      const path = resolveSkillPath(home, entry.source, name);
      if (!path) continue;
      resolved.push({ source: entry.source, name, content: readFileSync(path, 'utf8') });
    }
  }
  return resolved;
}

export interface MissingSkill { source: string; name: string; reviewers: string[] }

/** Every configured (source, name) that fails to resolve on disk — for `revu doctor`. */
export function findMissingSkills(
  entries: SkillContextEntry[],
  env: NodeJS.ProcessEnv = process.env,
): MissingSkill[] {
  const home = skillsHome(env);
  const missing: MissingSkill[] = [];
  for (const entry of entries) {
    for (const name of entry.include) {
      if (!resolveSkillPath(home, entry.source, name)) {
        missing.push({ source: entry.source, name, reviewers: entry.reviewers });
      }
    }
  }
  return missing;
}
