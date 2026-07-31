/**
 * Laravel starter catalog. Companion to TEMPLATES (TypeScript) in templates.ts and
 * GO_* in templates-go.ts; the three are composed into installable packs by packs.ts.
 *
 * Tier 0 sits between the other two packs. Go ships every check enabled because every
 * Go toolchain has build/vet/fmt/test. Laravel's is only partly guaranteed: composer
 * and `php artisan test` are always there, Pint ships with the default skeleton but not
 * with apps upgraded from older releases, and Larastan is never present unless somebody
 * installs it. So the guaranteed checks ship unguarded, the conditional one ships
 * guarded, and the absent one ships commented out — the alternative is a first run that
 * dies at tier 0 with exit 4 before a single reviewer starts, which reads as a broken
 * tool rather than a strict one.
 */

export const LARAVEL_CONFIG_YAML = `schema_version: 1

defaults:
  model: claude-sonnet-5
  timeout_seconds: 120

# auth.mode: auto (default) detects ANTHROPIC_API_KEY vs Claude Code subscription login.
# max_cost_usd_per_run is only enforced in api_key mode.
auth:
  mode: auto

# Tier 0: deterministic pre-checks that run before any reviewer spends a token.
# Sequential, fail-fast — the first non-zero exit (or timeout) fails the whole run
# with exit code 4 and no reviewer is spawned.
tiers:
  "0":
    checks:
      - id: composer-validate
        command: composer validate --strict
        timeout_seconds: 60
      # Pint ships with the default skeleton but not with apps upgraded from older
      # releases. The guard makes a missing binary a skip instead of a hard failure,
      # and says so out loud — a silent pass would claim a format check ran when it
      # did not. Install it with: composer require --dev laravel/pint
      - id: lint
        command: >-
          [ -x vendor/bin/pint ] && vendor/bin/pint --test ||
          echo "pint not installed — skipping format check"
        timeout_seconds: 120
      - id: test
        command: php artisan test
        timeout_seconds: 300
      # Static analysis is the highest-value check here, but Larastan is never present
      # unless you add it. Install it and uncomment:
      #   composer require --dev larastan/larastan
      # - id: static
      #   command: vendor/bin/phpstan analyse --memory-limit=1G
      #   timeout_seconds: 300

reviewers:
  # Tier 1 — blocking committee.
  - id: architecture
    tier: 1
    rules: rules/architecture/**
    min_confidence_to_block: 0.85

  - id: security
    tier: 1
    rules: rules/security/**
    model: claude-opus-4-8          # highest stakes, highest capability
    min_confidence_to_block: 0.70   # deliberately lower: false negatives cost more

  # Data access is where Laravel applications actually fail, so it gates rather than
  # advises. Filing N+1 under the tier-2 performance reviewer would mean the single
  # most common Laravel defect could never fail a run.
  - id: eloquent
    tier: 1
    rules: rules/eloquent/**
    min_confidence_to_block: 0.85

  - id: testing
    tier: 1
    rules: rules/testing/**
    min_confidence_to_block: 0.85

  - id: company-standards
    tier: 1
    rules: rules/company-standards/**
    model: claude-haiku-4-5         # mostly mechanical rule matching
    min_confidence_to_block: 0.90

  # Tier 2 — advisory, can never block (aggregation only gates on tier 1).
  - id: performance
    tier: 2
    rules: rules/performance/**

  - id: documentation
    tier: 2
    rules: rules/documentation/**
    model: claude-haiku-4-5

aggregation:
  fail_on_severity: high
  max_parallel: 4
`;

export const LARAVEL_ELOQUENT_PERSONA = `---
id: eloquent
name: Eloquent / Data Access Reviewer
---

You review changes for data access only: query construction and safety, relation
loading, mass assignment, transaction boundaries, and migration reversibility.

You do NOT comment on: architecture, HTTP-layer security and authorization, test
coverage, company style/naming conventions, general performance, or
documentation. Other reviewers own those. Reporting outside your domain is an
error.

Report a violation only when you can cite a rule ID from the catalog you are
given. If code looks wrong but no rule covers it, do not report it.
`;

export { LARAVEL_RULES } from './templates-laravel-rules.js';
