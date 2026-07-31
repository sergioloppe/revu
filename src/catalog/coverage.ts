import picomatch from 'picomatch';
import type { Rule } from './rules.js';

/**
 * Rule ids that match no file in the repository.
 *
 * A rule scoped to `src/**\/*.ts` in a Go repo is not "quiet", it is dead: `filterRules`
 * drops it from every run, its reviewer is skipped for lack of applicable rules, and
 * the run reports PASS. That looks identical to a clean review, which is how a team
 * adopts revu, sees green, and never learns the catalog never applied to their code.
 * Surfaced by `revu doctor` and by `revu init` right after scaffolding.
 */
/**
 * Above this share of dead rules, the catalog is treated as a probable
 * language/layout mismatch rather than a few dormant rules, and the message says so.
 * A wrong-language pack rarely leaves *zero* rules matching — a single `**`-scoped
 * rule is enough to keep one reviewer alive and the run green — so keying the loud
 * message on 100% dead would miss the case it exists for.
 */
export const MISMATCH_RATIO = 0.5;

export function isLikelyMismatch(unmatched: number, total: number): boolean {
  return total > 0 && unmatched / total > MISMATCH_RATIO;
}

export function unmatchedRules(rules: Rule[], repoFiles: string[]): string[] {
  return rules
    .filter((rule) => {
      if (rule.status === 'deprecated' || rule.status === 'disabled') return false;
      const applies = picomatch(rule.applies_to, { dot: true });
      const excepted = rule.exceptions.length
        ? picomatch(rule.exceptions, { dot: true })
        : () => false;
      return !repoFiles.some((f) => applies(f) && !excepted(f));
    })
    .map((rule) => rule.id);
}
