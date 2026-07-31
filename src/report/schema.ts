import { z } from 'zod';
import { SeveritySchema } from '../config/schema.js';

/**
 * A concrete, appliable edit: the exact text that should replace lines
 * `line`..`line_end` of the issue's file. Deliberately a line-range replacement
 * rather than a unified diff — a model writing a diff has to get hunk headers and
 * context lines right, and a malformed hunk is unusable, whereas "replace these
 * lines with this text" is verifiable against the file we already read.
 */
export const ModelFixSchema = z.object({
  /** First line replaced. Defaults to the issue's `line`. */
  line: z.number().int().positive().optional(),
  /** Last line replaced (inclusive). Defaults to `line`, or the issue's `line_end`. */
  line_end: z.number().int().positive().optional(),
  /** Replacement text for that range, with the file's original indentation. */
  replacement: z.string(),
});

export const ModelIssueSchema = z.object({
  rule: z.string(),
  message: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  line_end: z.number().int().positive().optional(),
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1),
  suggestion: z.string().optional(),
  fix: ModelFixSchema.optional(),
});

export const ModelReportSchema = z.object({
  schema_version: z.literal(1),
  reviewer: z.string(),
  status: z.enum(['PASS', 'PASS_WITH_WARNINGS', 'FAIL', 'NEEDS_HUMAN_REVIEW']),
  confidence: z.number().min(0).max(1),
  severity: z.union([SeveritySchema, z.literal('none')]),
  summary: z.string(),
  issues: z.array(ModelIssueSchema).default([]),
});
export type ModelReport = z.infer<typeof ModelReportSchema>;

/**
 * A model `fix` after the orchestrator has resolved its line range and read the
 * text it replaces. `original` is captured at review time so the rendered
 * before/after reflects the file the reviewer actually saw.
 */
export interface ResolvedFix {
  line: number;
  line_end: number;
  replacement: string;
  original: string;
}

export type Issue =
  Omit<z.infer<typeof ModelIssueSchema>, 'fix'> & { id: string; fix?: ResolvedFix };
export type ReviewerReport = Omit<ModelReport, 'issues'> & { issues: Issue[]; debug?: string; cached?: true };

/** JSON Schema text rendered into every reviewer prompt (design §3.1). */
export const REPORT_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  required: ['schema_version', 'reviewer', 'status', 'confidence', 'severity', 'summary', 'issues'],
  properties: {
    schema_version: { const: 1 },
    reviewer: { type: 'string' },
    status: { enum: ['PASS', 'PASS_WITH_WARNINGS', 'FAIL', 'NEEDS_HUMAN_REVIEW'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    severity: { enum: ['critical', 'high', 'medium', 'low', 'none'] },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rule', 'message', 'file', 'line', 'severity', 'confidence'],
        properties: {
          rule: { type: 'string' }, message: { type: 'string' }, file: { type: 'string' },
          line: { type: 'integer', minimum: 1 }, line_end: { type: 'integer', minimum: 1 },
          severity: { enum: ['critical', 'high', 'medium', 'low'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          suggestion: { type: 'string' },
          fix: {
            type: 'object',
            description:
              'The concrete edit that resolves this finding: the exact text replacing ' +
              'lines line..line_end of this file. Required for any finding in a code file.',
            required: ['replacement'],
            properties: {
              line: { type: 'integer', minimum: 1 },
              line_end: { type: 'integer', minimum: 1 },
              replacement: { type: 'string' },
            },
          },
        },
      },
    },
  },
}, null, 2);
