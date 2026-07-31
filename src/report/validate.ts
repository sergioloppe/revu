import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_FIX_LINES } from '../constants.js';
import { ModelReportSchema, type ResolvedFix, type ReviewerReport } from './schema.js';
import type { z } from 'zod';
import type { ModelFixSchema, ModelIssueSchema } from './schema.js';

function normalize(span: string): string {
  return span
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, '');
}

export function stableFindingId(ruleId: string, relPath: string, span: string): string {
  return createHash('sha256').update(ruleId + relPath + normalize(span)).digest('hex').slice(0, 8);
}

function citedSpan(repoRoot: string, file: string, line: number, lineEnd: number | undefined, fallback: string): string {
  try {
    const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');
    return lines.slice(line - 1, (lineEnd ?? line)).join('\n') || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Resolves a model-proposed fix against the file on disk, returning undefined when
 * it doesn't hold up. A fix is dropped (the finding survives without it) when the
 * file can't be read, the range falls outside it, the range is inverted, the edit
 * exceeds MAX_FIX_LINES, or the replacement is identical to what's already there —
 * a suggestion that can't be applied is worse than no suggestion.
 */
function resolveFix(
  repoRoot: string,
  issue: z.infer<typeof ModelIssueSchema>,
  fix: z.infer<typeof ModelFixSchema>,
): ResolvedFix | undefined {
  const start = fix.line ?? issue.line;
  const end = fix.line_end ?? fix.line ?? issue.line_end ?? start;
  if (end < start) return undefined;
  if (end - start + 1 > MAX_FIX_LINES) return undefined;
  if (fix.replacement.split('\n').length > MAX_FIX_LINES) return undefined;

  let lines: string[];
  try {
    lines = readFileSync(join(repoRoot, issue.file), 'utf8').split('\n');
  } catch {
    return undefined;
  }
  if (start > lines.length || end > lines.length) return undefined;

  const original = lines.slice(start - 1, end).join('\n');
  // Trailing-newline noise shouldn't count as a difference.
  if (original.trimEnd() === fix.replacement.trimEnd()) return undefined;
  return { line: start, line_end: end, replacement: fix.replacement, original };
}

function stripFences(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1]! : text).trim();
}

export interface ValidateCtx {
  reviewerId: string; diffFiles: string[]; ruleIds: Set<string>; repoRoot: string;
}
export type ValidateResult =
  | { ok: true; report: ReviewerReport; costUsd: number | null }
  | { ok: false; error: string };

export function validateReviewerOutput(stdout: string, ctx: ValidateCtx): ValidateResult {
  let envelope: unknown;
  try { envelope = JSON.parse(stdout); } catch {
    return { ok: false, error: 'claude envelope is not valid JSON' };
  }
  const result = (envelope as { result?: unknown }).result;
  if (typeof result !== 'string') return { ok: false, error: 'claude envelope has no string "result"' };
  const costRaw = (envelope as { total_cost_usd?: unknown }).total_cost_usd;
  const costUsd = typeof costRaw === 'number' ? costRaw : null;

  let raw: unknown;
  try { raw = JSON.parse(stripFences(result)); } catch {
    return { ok: false, error: 'reviewer output is not valid JSON' };
  }
  const parsed = ModelReportSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, error: `schema validation failed: ${detail}` };
  }

  const diffSet = new Set(ctx.diffFiles);
  const retained = parsed.data.issues.filter((i) => diffSet.has(i.file));
  const unknown = retained.filter((i) => !ctx.ruleIds.has(i.rule));
  if (unknown.length) {
    return { ok: false, error: `unknown rule id(s): ${[...new Set(unknown.map((i) => i.rule))].join(', ')}` };
  }
  const issues = retained.map((i) => {
    const { fix, ...rest } = i;
    return {
      ...rest,
      id: stableFindingId(i.rule, i.file, citedSpan(ctx.repoRoot, i.file, i.line, i.line_end, i.message)),
      ...(fix ? { fix: resolveFix(ctx.repoRoot, i, fix) } : {}),
    };
  });

  return { ok: true, report: { ...parsed.data, reviewer: ctx.reviewerId, issues }, costUsd };
}
