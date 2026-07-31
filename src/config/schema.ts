import { z } from 'zod';
import { DEFAULT_MODEL, DEFAULT_TIMEOUT_SECONDS } from '../constants.js';

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);
export type Severity = z.infer<typeof SeveritySchema>;

export const ReviewerConfigSchema = z.object({
  id: z.string().min(1),
  tier: z.union([z.literal(1), z.literal(2)]),
  rules: z.string().min(1),
  context: z.array(z.string()).default([]),
  model: z.string().default(DEFAULT_MODEL),
  min_confidence_to_block: z.number().min(0).max(1).default(0.85),
});
export type ReviewerConfig = z.infer<typeof ReviewerConfigSchema>;

export const Tier0CheckSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  timeout_seconds: z.number().positive().optional(),
  /**
   * Whether failing this check gates the run (exit 4, no reviewer spawned) or is
   * merely reported. Mirrors the same field on rules, and defaults to `true` for the
   * same reason global rules default to advisory: a config that predates this field
   * keeps the gating it already had, rather than silently losing it on upgrade.
   *
   * `false` suits checks whose failure says nothing about whether the *diff* is worth
   * reviewing — repo-hygiene checks like `composer validate` or a formatter, which
   * routinely fail on pre-existing conditions unrelated to the change under review.
   */
  blocking: z.boolean().default(true),
});
export type Tier0Check = z.infer<typeof Tier0CheckSchema>;

export const Tier0ConfigSchema = z.object({
  checks: z.array(Tier0CheckSchema).default([]),
});
export type Tier0Config = z.infer<typeof Tier0ConfigSchema>;

// Installed Claude Code skill-set awareness (design §5.3): resolves named skills'
// SKILL.md content and injects it as prompt context for the listed reviewers only.
// Off by default (empty array) — nothing is injected unless explicitly configured.
export const SkillContextEntrySchema = z.object({
  source: z.string().min(1),
  include: z.array(z.string()).min(1),
  reviewers: z.array(z.string()).min(1),
});
export type SkillContextEntry = z.infer<typeof SkillContextEntrySchema>;

export const ContextConfigSchema = z.object({
  skills: z.array(SkillContextEntrySchema).default([]),
});
export type ContextConfig = z.infer<typeof ContextConfigSchema>;

export const ConfigSchema = z.object({
  schema_version: z.literal(1),
  revu_version: z.string().optional(),
  inherit_global: z.boolean().default(true),
  defaults: z
    .object({
      model: z.string().default(DEFAULT_MODEL),
      timeout_seconds: z.number().positive().default(DEFAULT_TIMEOUT_SECONDS),
      max_output_tokens: z.number().positive().default(4000),
    })
    .default({}),
  auth: z
    .object({
      mode: z.enum(['auto', 'subscription', 'api_key']).default('auto'),
      max_cost_usd_per_run: z.number().positive().optional(),
    })
    .default({}),
  reviewers: z.array(ReviewerConfigSchema).default([]),
  context: ContextConfigSchema.default({}),
  // Keyed by tier number as a string: YAML `0:` parses to a scalar that JS then
  // coerces to the object key "0" regardless of the YAML lib's number/string
  // resolution, so a plain string key here matches either way.
  tiers: z.object({ '0': Tier0ConfigSchema.optional() }).default({}),
  aggregation: z
    .object({
      fail_on_severity: SeveritySchema.default('high'),
      max_parallel: z.number().int().positive().default(4),
    })
    .default({}),
});
export type EffectiveConfig = z.infer<typeof ConfigSchema>;
