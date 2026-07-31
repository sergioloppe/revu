import { findRepoRoot } from '../gitio/repo.js';
import { LANGUAGES, PACKS, detectLanguage, type Language } from '../packs.js';
import { EXIT } from '../constants.js';

const ESC = String.fromCharCode(27) + '[';
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const RESET = `${ESC}0m`;

export interface LanguageRow {
  id: Language;
  label: string;
  /** Files whose presence at the repo root identifies this language. */
  markers: string[];
  /** Packs this one outranks when both match; empty when it outranks nothing. */
  beats: Language[];
}

export interface LanguageList {
  languages: LanguageRow[];
  /** The pack `revu init` would pick here, or null outside a repo / on an ambiguous match. */
  detected: Language | null;
}

/**
 * Every rule pack `--lang` accepts, derived wholly from PACKS so a new pack shows up
 * here the moment it is registered — there is no second list to keep in sync.
 *
 * `repoRoot` is nullable because listing the packs is a static question: `revu
 * languages` has to answer it outside a git repo too, where detection simply has no
 * answer rather than being an error.
 */
export function buildLanguages(repoRoot: string | null): LanguageList {
  return {
    languages: LANGUAGES.map((id) => ({
      id,
      label: PACKS[id].label,
      markers: [...PACKS[id].markers],
      beats: [...(PACKS[id].beats ?? [])],
    })),
    detected: repoRoot === null ? null : detectLanguage(repoRoot),
  };
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - s.length));
}

export function renderLanguages(list: LanguageList, useColor: boolean): string {
  const c = (code: string, s: string) => (useColor ? `${code}${s}${RESET}` : s);
  const idWidth = Math.max(2, ...list.languages.map((l) => l.id.length));
  const labelWidth = Math.max(5, ...list.languages.map((l) => l.label.length));

  const lines = [
    '',
    '  ' + c(BOLD, `${pad('ID', idWidth)}  ${pad('LABEL', labelWidth)}  DETECTED BY`),
  ];
  for (const l of list.languages) {
    // `beats` is what makes an otherwise-ambiguous repo resolve (a Laravel app also
    // ships package.json), so it belongs next to the markers that cause the tie.
    const beats = l.beats.length ? c(DIM, `  (outranks: ${l.beats.join(', ')})`) : '';
    lines.push(`  ${pad(l.id, idWidth)}  ${pad(l.label, labelWidth)}  ${l.markers.join(', ')}${beats}`);
  }
  lines.push('');
  lines.push(list.detected
    ? `  detected in this repo: ${c(BOLD, list.detected)} (${PACKS[list.detected].label})`
    : c(DIM, '  detected in this repo: none — pass --lang explicitly'));
  lines.push('');
  lines.push(c(DIM, '  use with: revu init --lang <id>'));
  return lines.join('\n');
}

/**
 * `revu languages`: prints the packs `revu init --lang` accepts. Always exits 0 —
 * asking what is supported is never itself a failure, so being outside a git repo
 * drops the detection line rather than erroring.
 */
export function languagesCommand(cwd: string, opts: { json?: boolean } = {}): number {
  let repoRoot: string | null = null;
  try {
    repoRoot = findRepoRoot(cwd);
  } catch {
    repoRoot = null;
  }
  const list = buildLanguages(repoRoot);
  console.log(opts.json
    ? JSON.stringify(list, null, 2)
    : renderLanguages(list, process.stdout.isTTY === true));
  return EXIT.PASS;
}
