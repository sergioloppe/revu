/**
 * Go starter catalog. Companion to TEMPLATES (TypeScript) in templates.ts; the two
 * are composed into installable packs by packs.ts.
 *
 * Unlike the TypeScript pack, tier 0 ships enabled rather than commented out: every
 * Go toolchain has `go build`, `go vet`, `gofmt`, and `go test`, so there is nothing
 * to guess and no reason to make the cheapest, most deterministic gate opt-in.
 */

export const GO_CONFIG_YAML = `schema_version: 1

defaults:
  model: claude-sonnet-5
  timeout_seconds: 120

# auth.mode: auto (default) detects ANTHROPIC_API_KEY vs Claude Code subscription login.
# max_cost_usd_per_run is only enforced in api_key mode.
auth:
  mode: auto

# Tier 0: deterministic pre-checks that run before any reviewer spends a token.
# Sequential, fail-fast — the first non-zero exit (or timeout) fails the whole run
# with exit code 4 and no reviewer is spawned. Add a linter here once you have one
# configured (e.g. golangci-lint run).
tiers:
  "0":
    checks:
      - id: build
        command: go build ./...
        timeout_seconds: 180
      - id: vet
        command: go vet ./...
        timeout_seconds: 120
      # Prints the offending files before failing. The terser
      # \`test -z "$(gofmt -l .)"\` idiom swallows the file list into the command
      # substitution and fails with no output at all, which tells you nothing.
      - id: fmt
        command: >-
          out=$(gofmt -l .); [ -z "$out" ] ||
          { echo "gofmt: these files need formatting (run: gofmt -w .)"; echo "$out"; exit 1; }
        timeout_seconds: 60
      - id: test
        command: go test ./...
        timeout_seconds: 300

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

  - id: reliability
    tier: 1
    rules: rules/reliability/**
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

export const GO_RELIABILITY_PERSONA = `---
id: reliability
name: Reliability Reviewer
---

You review changes for runtime reliability only: error handling and propagation,
process lifecycle, cancellation, and graceful shutdown.

You do NOT comment on: architecture, security, test coverage, company
style/naming conventions, performance, or documentation. Other reviewers own
those. Reporting outside your domain is an error.

Report a violation only when you can cite a rule ID from the catalog you are
given. If code looks wrong but no rule covers it, do not report it.
`;

export { GO_RULES } from './templates-go-rules.js';
