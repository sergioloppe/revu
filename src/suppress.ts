import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Issue, ReviewerReport } from './report/schema.js';

export interface BaselineEntry {
  id: string;
  rule: string;
  file: string;
}
export interface Baseline {
  generated_at: string;
  findings: BaselineEntry[];
}

export interface DismissalEntry {
  id: string;
  rule: string;
  reason: string;
  approved_by: string;
  /** ISO date (YYYY-MM-DD) or full timestamp; expired entries are inactive. */
  expires: string;
}

/** A finding removed from `aggregate`'s view, surfaced on the envelope instead. */
export type SuppressedIssue = Issue & {
  reviewer: string;
  suppressed_by: 'baseline' | 'dismissal';
  reason?: string;
};

function baselinePath(repoRoot: string): string {
  return join(repoRoot, '.review', 'baseline.json');
}
function dismissalsPath(repoRoot: string): string {
  return join(repoRoot, '.review', 'dismissals.yaml');
}

/** Missing or corrupt baseline files are both treated as "no baseline". */
export function readBaseline(repoRoot: string): Baseline | null {
  const path = baselinePath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Baseline>;
    if (!Array.isArray(parsed.findings)) return null;
    return { generated_at: parsed.generated_at ?? '', findings: parsed.findings };
  } catch {
    return null;
  }
}

/** Writes every finding id (+rule, file) across `reports` to `.review/baseline.json`. */
export function writeBaseline(repoRoot: string, reports: ReviewerReport[]): Baseline {
  const findings: BaselineEntry[] = reports.flatMap((report) =>
    report.issues.map((issue) => ({ id: issue.id, rule: issue.rule, file: issue.file })));
  const baseline: Baseline = { generated_at: new Date().toISOString(), findings };
  const path = baselinePath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(baseline, null, 2));
  return baseline;
}

/** Missing or corrupt dismissals files are both treated as "no dismissals". */
export function readDismissals(repoRoot: string): DismissalEntry[] {
  const path = dismissalsPath(repoRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = parseYaml(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? (parsed as DismissalEntry[]) : [];
  } catch {
    return [];
  }
}

export function isDismissalActive(entry: DismissalEntry, now: Date = new Date()): boolean {
  const expires = new Date(entry.expires).getTime();
  return !Number.isNaN(expires) && expires > now.getTime();
}

/** Appends one entry to `.review/dismissals.yaml`, creating the directory if needed. */
export function appendDismissal(repoRoot: string, entry: DismissalEntry): DismissalEntry[] {
  const updated = [...readDismissals(repoRoot), entry];
  const path = dismissalsPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(updated));
  return updated;
}

/**
 * Pure suppression pass (design §9/10.1-10.2, plan Task 5): partitions each report's
 * issues into those an active baseline entry or dismissal covers (moved to the
 * returned `suppressed` list) and those that remain visible to `aggregate`. Dismissals
 * take precedence over the baseline when both cover the same id (a dismissal always
 * carries a `reason`; a bare baseline entry never does).
 */
export function suppressFindings(
  reports: ReviewerReport[],
  baseline: Baseline | null,
  dismissals: DismissalEntry[],
  now: Date = new Date(),
): { reports: ReviewerReport[]; suppressed: SuppressedIssue[] } {
  const baselineIds = new Set((baseline?.findings ?? []).map((f) => f.id));
  const activeDismissalsById = new Map(
    dismissals.filter((d) => isDismissalActive(d, now)).map((d) => [d.id, d]),
  );

  const suppressed: SuppressedIssue[] = [];
  const suppressedReports = reports.map((report) => {
    const retained: Issue[] = [];
    for (const issue of report.issues) {
      const dismissal = activeDismissalsById.get(issue.id);
      if (dismissal) {
        suppressed.push({ ...issue, reviewer: report.reviewer, suppressed_by: 'dismissal', reason: dismissal.reason });
      } else if (baselineIds.has(issue.id)) {
        suppressed.push({ ...issue, reviewer: report.reviewer, suppressed_by: 'baseline' });
      } else {
        retained.push(issue);
      }
    }
    return retained.length === report.issues.length ? report : { ...report, issues: retained };
  });
  return { reports: suppressedReports, suppressed };
}
