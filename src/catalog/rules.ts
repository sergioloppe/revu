import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import matter from 'gray-matter';
import picomatch from 'picomatch';
import { z } from 'zod';
import { SeveritySchema, type Severity } from '../config/schema.js';
import { ConfigError } from '../errors.js';

const RuleFrontmatter = z.object({
  id: z.string().min(1),
  title: z.string().default(''),
  domain: z.string().default(''),
  severity: SeveritySchema.default('medium'),
  blocking: z.boolean().default(false),
  status: z.enum(['proposed', 'active', 'deprecated', 'disabled']).default('proposed'),
  since: z.string().optional(),
  applies_to: z.array(z.string()).default(['**']),
  exceptions: z.array(z.string()).default([]),
});

export interface Rule {
  id: string; title: string; domain: string; severity: Severity; blocking: boolean;
  status: 'proposed' | 'active' | 'deprecated' | 'disabled';
  applies_to: string[]; exceptions: string[]; body: string; origin: 'global' | 'repo'; relPath: string;
}

function mdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f));
}

export function loadRules(sources: Array<{ dir: string; origin: 'global' | 'repo' }>): Rule[] {
  const byId = new Map<string, Rule>();
  for (const { dir, origin } of sources) {
    for (const file of mdFiles(dir)) {
      const { data, content } = matter(readFileSync(file, 'utf8'));
      const parsed = RuleFrontmatter.safeParse(data);
      if (!parsed.success) throw new ConfigError(`${file}: invalid rule frontmatter: ${parsed.error.message}`);
      const fm = parsed.data;
      const prev = byId.get(fm.id);
      if (fm.status === 'disabled') { byId.delete(fm.id); continue; }
      const relPath = relative(dir, file);
      const rule: Rule = {
        ...fm,
        body: content.trim(),
        origin,
        // Global-sourced rules never gate (design §4.3 reproducibility guard).
        blocking: origin === 'global' ? false : fm.blocking,
        exceptions: prev ? [...new Set([...prev.exceptions, ...fm.exceptions])] : fm.exceptions,
        relPath,
      };
      byId.set(fm.id, rule);
    }
  }
  return [...byId.values()];
}

export interface RuleCatalogEntry {
  id: string; domain: string; blocking: boolean; status: string; file: string; origin: 'global' | 'repo';
}
export interface RuleCatalogIssue { file: string; message: string }

/**
 * Raw, non-deduping scan of every rule file across `sources` — unlike `loadRules`,
 * which merges by id (repo intentionally overriding global, per design §4.3), this
 * keeps every file as its own entry so callers (doctor, `rules lint`, `config
 * promote`) can validate frontmatter and detect same-layer id collisions, which
 * `loadRules`'s merge-by-id would silently paper over.
 */
export function scanRuleCatalog(
  sources: Array<{ dir: string; origin: 'global' | 'repo' }>,
): { entries: RuleCatalogEntry[]; errors: RuleCatalogIssue[] } {
  const entries: RuleCatalogEntry[] = [];
  const errors: RuleCatalogIssue[] = [];
  for (const { dir, origin } of sources) {
    for (const file of mdFiles(dir)) {
      const { data } = matter(readFileSync(file, 'utf8'));
      const parsed = RuleFrontmatter.safeParse(data);
      if (!parsed.success) { errors.push({ file, message: parsed.error.message }); continue; }
      const fm = parsed.data;
      entries.push({ id: fm.id, domain: fm.domain, blocking: fm.blocking, status: fm.status, file, origin });
    }
  }
  return { entries, errors };
}

/**
 * Same rule id declared by more than one file within the SAME layer — ambiguous,
 * since which file "wins" depends on filesystem read order. A repo rule sharing an
 * id with a global rule is the intentional override mechanism, not a duplicate, so
 * cross-layer collisions are deliberately excluded here.
 */
export function findDuplicateRuleIds(entries: RuleCatalogEntry[]): Array<{ id: string; files: string[] }> {
  const byKey = new Map<string, RuleCatalogEntry[]>();
  for (const e of entries) {
    const key = `${e.origin}:${e.id}`;
    const list = byKey.get(key) ?? [];
    list.push(e);
    byKey.set(key, list);
  }
  return [...byKey.values()]
    .filter((list) => list.length > 1)
    .map((list) => ({ id: list[0]!.id, files: list.map((e) => e.file) }));
}

export function filterRules(rules: Rule[], changedFiles: string[]): Rule[] {
  return rules.filter((rule) => {
    if (rule.status === 'deprecated') return false;
    const applies = picomatch(rule.applies_to);
    const excepted = rule.exceptions.length ? picomatch(rule.exceptions) : () => false;
    return changedFiles.some((f) => applies(f) && !excepted(f));
  });
}
