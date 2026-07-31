import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATES } from './templates.js';
import { GO_CONFIG_YAML, GO_RELIABILITY_PERSONA, GO_RULES } from './templates-go.js';
import { LARAVEL_CONFIG_YAML, LARAVEL_ELOQUENT_PERSONA, LARAVEL_RULES } from './templates-laravel.js';

export const LANGUAGES = ['ts', 'go', 'laravel'] as const;
export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

export interface LanguagePack {
  id: Language;
  label: string;
  /** Files whose presence at the repo root identifies this language. */
  markers: string[];
  /**
   * Packs this one outranks when both match. A framework pack layered over a language
   * that also ships one of its markers would otherwise read as ambiguous — a Laravel
   * app's package.json is its asset pipeline, not a claim to be a TypeScript project.
   */
  beats?: Language[];
  /** Catalog files to write, relative to the target `.review/` directory. */
  files: Record<string, string>;
}

/** Reviewer personas are language-neutral, so every pack starts from the same set. */
const PERSONAS: Record<string, string> = Object.fromEntries(
  Object.entries(TEMPLATES).filter(([rel]) => rel.startsWith('reviewers/')),
);

function personasExcept(...ids: string[]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(PERSONAS).filter(([rel]) => !ids.some((id) => rel === `reviewers/${id}.md`)),
  );
}

export const PACKS: Record<Language, LanguagePack> = {
  ts: {
    id: 'ts',
    label: 'TypeScript / JavaScript',
    markers: ['package.json', 'tsconfig.json'],
    files: TEMPLATES,
  },
  go: {
    id: 'go',
    label: 'Go',
    markers: ['go.mod'],
    files: {
      // The Go catalog has a reliability domain and no maintainability domain, so its
      // persona set differs from the config's reviewer list by exactly those two.
      ...personasExcept('maintainability'),
      'reviewers/reliability.md': GO_RELIABILITY_PERSONA,
      'config.yaml': GO_CONFIG_YAML,
      ...GO_RULES,
    },
  },
  laravel: {
    id: 'laravel',
    label: 'Laravel',
    // `artisan` alone. Markers are OR'd, so adding composer.json here would claim every
    // Symfony and plain-PHP repo as Laravel.
    markers: ['artisan'],
    beats: ['ts'],
    files: {
      // Like Go, the Laravel catalog swaps the maintainability domain for one of its
      // own — data access, where Laravel applications actually fail.
      ...personasExcept('maintainability'),
      'reviewers/eloquent.md': LARAVEL_ELOQUENT_PERSONA,
      'config.yaml': LARAVEL_CONFIG_YAML,
      ...LARAVEL_RULES,
    },
  },
};

/**
 * Identifies the repo's language from marker files, or null when nothing matches or
 * more than one pack does — an ambiguous answer must not silently pick a catalog that
 * doesn't apply to the code.
 *
 * A declared `beats` relationship resolves the one ambiguity that is not a real tie:
 * a more specific pack outranks one it supersedes. Anything else stays null.
 */
export function detectLanguage(repoRoot: string): Language | null {
  const matched = LANGUAGES.filter((id) =>
    PACKS[id].markers.some((marker) => existsSync(join(repoRoot, marker))));
  const survivors = matched.filter((id) =>
    !matched.some((other) => PACKS[other].beats?.includes(id)));
  return survivors.length === 1 ? survivors[0]! : null;
}
