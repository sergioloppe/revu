import type { ReviewerReport } from '../report/schema.js';
import type { Rule } from '../catalog/rules.js';
import type { ReviewerConfig, Severity } from '../config/schema.js';
import { EXIT } from '../constants.js';

const RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

export interface AggregateResult {
  status: 'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL' | 'NEEDS_HUMAN_REVIEW';
  decision_reason: string;
  exitCode: number;
  demoted: string[];
}

export function aggregate(
  reports: ReviewerReport[],
  reviewers: ReviewerConfig[],
  rulesById: Map<string, Rule>,
  failOnSeverity: Severity,
): AggregateResult {
  const byId = new Map(reviewers.map((r) => [r.id, r]));
  const demoted: string[] = [];
  const blockingReviewers: string[] = [];
  let blockingCount = 0;
  let warnings = 0;
  let escalated = false;

  for (const report of reports) {
    if (report.status === 'NEEDS_HUMAN_REVIEW') { escalated = true; continue; }
    const cfg = byId.get(report.reviewer);
    for (const issue of report.issues) {
      const rule = rulesById.get(issue.rule);
      const confident = cfg !== undefined && issue.confidence >= cfg.min_confidence_to_block;
      const blocks = cfg?.tier === 1 && rule?.blocking === true && confident &&
        RANK[issue.severity] >= RANK[failOnSeverity];
      if (blocks) {
        blockingCount += 1;
        if (!blockingReviewers.includes(report.reviewer)) blockingReviewers.push(report.reviewer);
      } else {
        warnings += 1;
        if (cfg?.tier === 1 && rule?.blocking === true && !confident && RANK[issue.severity] >= RANK[failOnSeverity]) demoted.push(issue.id);
      }
    }
  }

  if (blockingCount > 0) {
    return {
      status: 'FAIL',
      decision_reason: `${blockingReviewers.join(', ')} reported ${blockingCount} blocking issue(s) at or above ${failOnSeverity}`,
      exitCode: EXIT.FAIL, demoted,
    };
  }
  if (escalated) {
    return { status: 'NEEDS_HUMAN_REVIEW', decision_reason: 'a reviewer required human review',
      exitCode: EXIT.NEEDS_HUMAN, demoted };
  }
  if (warnings > 0) {
    return { status: 'PASS_WITH_WARNINGS', decision_reason: `${warnings} advisory finding(s)`,
      exitCode: EXIT.PASS, demoted };
  }
  // A run where no reviewer produced a report is not a clean review — it means no
  // rule in the catalog applied to the changed files. Saying "no findings" there
  // reads as "reviewed and clean", which is how a mis-scoped catalog stays invisible.
  if (reports.length === 0) {
    return {
      status: 'PASS',
      decision_reason: 'no reviewers ran — no catalog rule applied to the changed files',
      exitCode: EXIT.PASS, demoted,
    };
  }
  return { status: 'PASS', decision_reason: 'no findings', exitCode: EXIT.PASS, demoted };
}
