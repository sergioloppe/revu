import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { ReviewerReport } from './schema.js';
import type { Rule } from '../catalog/rules.js';
import type { EffectiveConfig } from '../config/schema.js';
import type { Layer } from '../config/cascade.js';
import type { AuthMode } from '../executor/preflight.js';
import type { AggregateResult } from '../aggregate/aggregate.js';
import type { SuppressedIssue } from '../suppress.js';
import { REVU_VERSION } from '../constants.js';

const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

export interface Tier0EnvelopeCheck {
  id: string;
  status: 'PASS' | 'FAIL' | 'TIMEOUT';
  /** False means a failure here was reported but did not gate the run. */
  blocking: boolean;
  duration_ms: number;
}
export interface Tier0Envelope {
  /** FAIL iff a blocking check failed; advisory failures leave this PASS. */
  status: 'PASS' | 'FAIL';
  checks: Tier0EnvelopeCheck[];
}

export interface AggregateEnvelope {
  schema_version: 1; revu_version: string; generated_at: string;
  repo: string; commit: string; base: string;
  ruleset_hash: string; config_hash: string;
  config_layers: Layer[]; auth_mode: AuthMode;
  status: AggregateResult['status']; decision_reason: string;
  tier_0: Tier0Envelope | null;
  /** Tiers the caller skipped (--skip-tier). Non-empty means gates did not run. */
  skipped_tiers: number[];
  reviews: ReviewerReport[]; suppressed: SuppressedIssue[];
  /**
   * Changed paths withheld from every reviewer because they hold credential values.
   * Recorded so a reader can tell "no findings here" apart from "never looked".
   */
  excluded_paths: string[];
  cost: { usd: number | null }; duration_ms: number;
}

export function buildEnvelope(input: {
  repoRoot: string; commit: string; base: string;
  config: EffectiveConfig; layers: Layer[]; authMode: AuthMode;
  rules: Rule[]; reports: ReviewerReport[]; result: AggregateResult;
  costUsd: number | null; durationMs: number;
  /** null when no tier-0 checks are configured (or none ran). */
  tier0?: Tier0Envelope | null;
  /** Findings a baseline entry or active dismissal removed from `reports`/aggregation. */
  suppressed?: SuppressedIssue[];
  /** Tiers the caller skipped, recorded so a PASS can be read honestly. */
  skippedTiers?: number[];
  /** Changed paths withheld from reviewers because they hold secrets. */
  excludedPaths?: string[];
  /**
   * Extra strings folded into `config_hash` alongside the config itself — e.g. the
   * content of skill-set context docs injected into reviewer prompts (design §5.3).
   * Those files live outside the repo (`~/.claude/skills/**` or `$REVU_SKILLS_HOME`)
   * and can drift without any config change, so their content has to be part of the
   * reproducibility hash for that drift to be visible.
   */
  extraHashInputs?: string[];
}): AggregateEnvelope {
  const rulesetHash = sha(
    [...input.rules].sort((a, b) => a.id.localeCompare(b.id)).map((r) => r.id + r.body).join('\n'),
  );
  const configHashInput = [JSON.stringify(input.config), ...(input.extraHashInputs ?? [])].join('\n');
  return {
    schema_version: 1,
    revu_version: REVU_VERSION,
    generated_at: new Date().toISOString(),
    repo: basename(input.repoRoot),
    commit: input.commit,
    base: input.base,
    ruleset_hash: rulesetHash,
    config_hash: sha(configHashInput),
    config_layers: input.layers,
    auth_mode: input.authMode,
    status: input.result.status,
    decision_reason: input.result.decision_reason,
    tier_0: input.tier0 ?? null,
    skipped_tiers: input.skippedTiers ?? [],
    reviews: input.reports,
    suppressed: input.suppressed ?? [],
    excluded_paths: input.excludedPaths ?? [],
    cost: { usd: input.costUsd },
    duration_ms: input.durationMs,
  };
}
