import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATES } from './templates.js';
import { GO_CONFIG_YAML, GO_RELIABILITY_PERSONA, GO_RULES } from './templates-go.js';

export const LANGUAGES = ['ts', 'go'] as const;
export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

export interface LanguagePack {
  id: Language;
  label: string;
  /** Files whose presence at the repo root identifies this language. */
  markers: string[];
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
};

/**
 * Identifies the repo's language from marker files, or null when nothing matches or
 * more than one pack does — an ambiguous answer must not silently pick a catalog that
 * doesn't apply to the code.
 */
export function detectLanguage(repoRoot: string): Language | null {
  const matched = LANGUAGES.filter((id) =>
    PACKS[id].markers.some((marker) => existsSync(join(repoRoot, marker))));
  return matched.length === 1 ? matched[0]! : null;
}
