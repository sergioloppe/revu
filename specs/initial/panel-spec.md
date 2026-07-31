# `panel` — Specification

**A local-first, multi-reviewer AI code review pipeline built on Claude Code.**

Version 0.1 (draft) · Status: proposal

---

## 1. Purpose and scope

`panel` runs a committee of specialized AI reviewers against a diff, from the
developer's terminal, before a pull request exists. Each reviewer is narrow,
stateless, and returns a machine-readable verdict. An aggregator combines those
verdicts into a single pass/fail decision that CI can re-derive.

### Goals

1. Sub-two-minute feedback on a branch diff, invoked from anywhere inside a repo.
2. One directory holds all configuration: rules, reviewer definitions, context docs.
3. Every reviewer returns validated JSON against a fixed schema. No prose parsing.
4. Identical behaviour locally and in CI, from the same pinned version and config.
5. Rules are versioned artifacts owned by the team, not prompts buried in a script.

### Non-goals

- Replacing deterministic tooling. Linters, type checkers, and tests stay as they are;
  `panel` orchestrates them as a gate but does not reimplement them.
- Replacing human review. The output is an input to human review, not a substitute.
- Being the merge authority. Local results are advisory to CI; CI decides (§9).

---

## 2. Language and distribution

### Recommendation: TypeScript on Node 20+, distributed as an npm package

Rationale:

- The codebase being reviewed is TypeScript (per the reviewer examples). One language
  for the tool and the target lowers the barrier for engineers to add rules and fix bugs
  in the reviewer itself — which is the main maintenance cost of a system like this.
- `zod` gives runtime schema validation and static types from a single declaration,
  which is exactly the shape of the JSON contract problem in §5.
- If the orchestrator later graduates from spawning `claude -p` to embedding the
  Claude Agent SDK (§11), the TypeScript SDK surface is available and the migration
  touches only the executor layer.
- `npm install -g` plus a shim resolves the "invoke from anywhere" requirement without
  shipping platform-specific binaries.

The orchestrator is a process supervisor: discover repo root, compute a diff, build
prompts, spawn N `claude -p` subprocesses, validate their JSON, aggregate. It is I/O
and schema work. Node is a good fit and Python would be equally defensible.

### Alternative: Go

Choose Go instead if either of these is true:

- Engineers are on heterogeneous Node versions and you are unwilling to manage that.
  A single static binary with zero runtime dependency removes an entire class of
  "works on my machine" support burden.
- You want the pre-push hook to run with no `node_modules` present (fresh clone, CI
  container without install step).

The cost is that rule contributions and tool fixes now require a second language, and
the Agent SDK has no Go surface, so §11 becomes a rewrite rather than a refactor.

### Rejected

- **Shell.** Prompt assembly, JSON schema validation, parallel process management with
  timeouts, and structured error handling in bash is a maintenance trap.
- **Python.** Perfectly viable — `uv tool install` solves distribution cleanly. Rejected
  only on the "same language as the codebase" argument. If the team is polyglot or
  Python-leaning, switch this decision without changing anything else in this spec.

### Installation and version pinning

```bash
npm install -g @acme/panel     # provides the `panel` binary on PATH
```

The global binary is a **launcher, not the implementation**. On every invocation:

1. Walk up from `$PWD` to find the repo root (a directory containing `.git`).
2. Read `.review/config.yaml` → `panel_version`.
3. If `node_modules/@acme/panel` exists at that version, `exec` it.
4. Otherwise resolve the pinned version from the npm cache (installing if absent) and
   `exec` that.
5. Only fall back to the global implementation if no `.review/` is found at all, in
   which case emit a warning.

This is the `eslint`/`prettier` shim pattern and it exists to guarantee one property:
**the version that runs locally is the version that runs in CI**, because both read the
same pin from the same file. Without it, local and CI drift and engineers lose trust in
the local pass within a month.

Repos also add it to `devDependencies` so a fresh clone plus `npm ci` is sufficient —
the global install is a convenience for invoking from subdirectories, not a requirement.

---

## 3. Configuration layout

Everything lives in `.review/` at the repo root. Nothing is configured outside it. It is
committed to version control and reviewed like code.

```
.review/
├── config.yaml               # the only settings file
├── rules/
│   ├── architecture/
│   │   ├── ARCH-012.md
│   │   ├── ARCH-014.md
│   │   └── ...
│   ├── security/
│   │   └── SEC-003.md
│   ├── performance/
│   ├── testing/
│   ├── company/
│   ├── maintainability/
│   └── documentation/
├── reviewers/
│   ├── architecture.md       # reviewer persona + scope + output contract
│   ├── security.md
│   └── ...
├── context/
│   ├── architecture.md       # local copy or generated snapshot
│   ├── layering.md
│   └── sources.yaml          # remote docs to fetch and cache
├── schema/
│   ├── report.schema.json    # per-reviewer output contract
│   └── rule.schema.json      # frontmatter contract for rule files
├── baseline.json             # grandfathered findings (§10.1) — generated
├── dismissals.yaml           # human-approved suppressions (§10.2) — hand-edited
└── cache/                    # gitignored: fetched docs, memoized reviews
```

### 3.1 `config.yaml`

```yaml
panel_version: "0.4.2"
schema_version: 1

defaults:
  model: claude-sonnet-4-6
  timeout_seconds: 120
  max_output_tokens: 4000
  allowed_tools: [Read, Grep, Glob]   # never Write, Edit, or Bash

context:
  # Injected into every reviewer. Keep small — this is paid for N times per run.
  always: 
    - context/layering.md
  # Fetched, converted to markdown, cached by ETag in .review/cache/
  remote:
    - id: adr-index
      url: https://wiki.internal/architecture/adr-index
      ttl_hours: 168

tiers:
  0:
    name: deterministic
    blocking: true
    checks:
      - { id: lint,      command: "npm run lint",          timeout_seconds: 60 }
      - { id: typecheck, command: "npm run typecheck",     timeout_seconds: 120 }
      - { id: test,      command: "npm run test:affected", timeout_seconds: 300 }
      - { id: build,     command: "npm run build",         timeout_seconds: 300 }
  1:
    name: blocking-review
    blocking: true
  2:
    name: advisory-review
    blocking: false

reviewers:
  - id: architecture
    tier: 1
    rules: rules/architecture/**
    context: [context/architecture.md, context/layering.md]
    model: claude-sonnet-4-6
    min_confidence_to_block: 0.85

  - id: security
    tier: 1
    rules: rules/security/**
    model: claude-opus-4-8          # highest stakes, highest capability
    min_confidence_to_block: 0.70   # deliberately lower: false negatives cost more

  - id: testing
    tier: 1
    rules: rules/testing/**
    min_confidence_to_block: 0.85

  - id: company-standards
    tier: 1
    rules: rules/company/**
    model: claude-haiku-4-5         # mostly mechanical rule matching
    min_confidence_to_block: 0.90

  - id: performance
    tier: 2
    rules: rules/performance/**

  - id: maintainability
    tier: 2
    rules: rules/maintainability/**
    model: claude-haiku-4-5

  - id: documentation
    tier: 2
    rules: rules/documentation/**
    model: claude-haiku-4-5

aggregation:
  fail_on_severity: high            # any blocking-tier issue at or above this fails
  escalate_on_disagreement: true    # contradictory findings → NEEDS_HUMAN_REVIEW
  max_parallel: 4
  max_cost_usd_per_run: 1.50        # hard stop; partial results returned
```

Note the per-reviewer `model` and `min_confidence_to_block`. These are the two levers
that make a seven-reviewer fan-out economically viable and politically survivable:
spend frontier capability only where the cost of a miss is high, and let each reviewer
carry its own tolerance for being wrong.

### 3.2 Rule files

Each rule is one markdown file. The frontmatter is the machine contract; the body is
the prompt fragment.

```markdown
---
id: ARCH-012
title: No business logic in controllers
domain: architecture
severity: high            # critical | high | medium | low
blocking: true
status: active            # proposed | active | deprecated
since: "2026-03-14"
applies_to:
  - "src/**/*Controller.ts"
exceptions:
  - "src/health/**"
  - "src/**/*.legacy.ts"
---

Controllers translate between transport and the domain. They may validate input shape,
call exactly one application service, and map the result to a response. They may not
branch on domain state, perform calculations, or orchestrate multiple services.

## Violating

```ts
// OrderController.ts
if (order.total > 1000 && user.tier === 'basic') {
  order.requiresApproval = true;   // domain decision made in the controller
}
```

## Compliant

```ts
const order = await this.orderService.submit(dto, user);
```

## How to fix

Move the decision into the domain service or the aggregate that owns the invariant.
```

`applies_to` and `exceptions` are evaluated **deterministically by the orchestrator**
before the reviewer runs. A rule that cannot apply to any file in the diff is never
loaded into the prompt. This is the single largest cost lever in the system: on a
typical diff touching four files, most of the catalog is irrelevant.

### 3.3 Reviewer files

```markdown
---
id: architecture
name: Architecture Reviewer
---

You review changes for architectural integrity only.

You do NOT comment on: formatting, naming, test coverage, documentation, performance,
or security. Other reviewers own those. Reporting outside your domain is an error.

Report a violation only when you can cite a rule ID from the catalog below. If code
looks wrong but no rule covers it, do not report it — open a pull request against the
rule catalog instead.
```

Scope discipline in the negative ("you do NOT comment on...") matters more than the
positive framing. Without it, every reviewer converges on generic code review and you
have paid seven times for one opinion.

---

## 4. CLI surface

```
panel                          # review the branch diff vs merge-base (default)
panel --staged                 # review staged changes only
panel --range main...HEAD      # explicit git range
panel --files src/a.ts src/b.ts

panel --tier 1                 # run tier 0 and 1 only
panel --only security,testing  # run named reviewers regardless of tier
panel --skip documentation

panel --format pretty          # default when stdout is a TTY
panel --format json            # full envelope to stdout; default when piped
panel --format sarif           # for GitHub code scanning ingestion
panel --output .review-report.json

panel --no-cache               # ignore memoized results
panel --explain ARCH-012       # print the rule file, rendered
panel --dismiss <finding-id> --reason "..."   # append to dismissals.yaml
panel --baseline               # regenerate baseline.json from current HEAD

panel init                     # scaffold .review/ with a starter catalog
panel doctor                   # validate config, rules, schema, claude auth, versions
panel rules lint               # duplicate IDs, bad frontmatter, dead exceptions
panel eval                     # run the rule catalog against golden fixtures (§10.3)
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | `PASS` or `PASS_WITH_WARNINGS` |
| 1 | `FAIL` — a blocking reviewer reported a blocking issue |
| 2 | `NEEDS_HUMAN_REVIEW` — reviewers contradicted, or schema validation failed after retry |
| 3 | Tool error — bad config, `claude` not authenticated, timeout, cost cap hit |
| 4 | Tier 0 failure — lint/typecheck/test/build failed; no reviewers were run |

Exit code 4 being distinct from 1 matters for the hook: engineers should immediately
understand that no tokens were spent and the fix is mechanical.

### Repo root discovery

`panel` walks up from `$PWD` looking for `.git`. The `.review/` directory is expected at
that root. In a monorepo, `.review/` may also exist in a workspace subdirectory; the
nearest one to `$PWD` wins, and its `extends: ../../.review/config.yaml` key merges
against the root config so shared rules are not duplicated per package.

---

## 5. The JSON contract

### 5.1 Per-reviewer report

This is the exact structure each reviewer must emit, extending the proposed shape with
the fields the orchestrator needs for caching, suppression, and audit.

```json
{
  "schema_version": 1,
  "reviewer": "architecture",
  "status": "FAIL",
  "confidence": 0.98,
  "severity": "high",
  "summary": "Business logic introduced into the order controller.",
  "issues": [
    {
      "id": "a3f9c1e2",
      "rule": "ARCH-012",
      "message": "Business logic introduced into the controller.",
      "file": "src/orders/OrderController.ts",
      "line": 87,
      "line_end": 91,
      "severity": "high",
      "confidence": 0.98,
      "suggestion": "Move the approval threshold decision into OrderService.submit()."
    }
  ]
}
```

Field rules:

- `status` ∈ `PASS` | `PASS_WITH_WARNINGS` | `FAIL` | `NEEDS_HUMAN_REVIEW`.
- `severity` at the top level is the maximum of `issues[].severity`, or `"none"` when empty.
- `confidence` at the top level is the reviewer's confidence in its overall verdict;
  `issues[].confidence` is per-finding. The aggregator uses the per-finding value.
- `rule` must exist in the loaded catalog. Unknown rule IDs invalidate the report.
- `file` must be a path present in the diff. Findings outside the diff are dropped.
- `id` is **computed by the orchestrator, not the model** (§5.3).

### 5.2 Aggregate envelope

What `--format json` writes:

```json
{
  "schema_version": 1,
  "panel_version": "0.4.2",
  "generated_at": "2026-07-19T14:22:31Z",
  "repo": "acme/orders-service",
  "commit": "9f2c1ab...",
  "base": "3d81e40...",
  "ruleset_hash": "sha256:7c1f...",
  "config_hash": "sha256:2b9e...",
  "status": "FAIL",
  "decision_reason": "architecture reported 1 high-severity blocking issue",
  "tier_0": {
    "status": "PASS",
    "checks": [{ "id": "lint", "status": "PASS", "duration_ms": 4210 }]
  },
  "reviews": [ /* array of per-reviewer reports */ ],
  "suppressed": [ /* findings removed by baseline or dismissals, with reason */ ],
  "cost": { "usd": 0.41, "input_tokens": 128400, "output_tokens": 3100 },
  "duration_ms": 47120
}
```

`ruleset_hash` and `config_hash` are what let CI decide whether a locally produced
report is still valid (§9).

### 5.3 Stable finding IDs

Line numbers move on rebase; a suppression keyed to `file:line` breaks immediately.
Instead:

```
id = sha256(rule_id + relative_path + normalize(source_span))[0:8]
```

where `normalize` strips whitespace and comments from the cited span. A finding keeps
its ID across reformatting and unrelated edits above it, and only changes when the
offending code itself changes — which is the correct moment for a suppression to lapse.

### 5.4 Enforcing the contract

`claude -p --output-format json` returns an envelope whose `result` field is the
model's text. The orchestrator:

1. Extracts `result`, strips markdown code fences.
2. Parses as JSON. On failure → retry step 4.
3. Validates against `report.schema.json` (zod). On failure → retry step 4.
4. **Retry once**, appending the validation error to the prompt: *"Your previous
   response failed schema validation with the following error. Return only valid JSON
   matching the schema."*
5. On second failure, emit `status: NEEDS_HUMAN_REVIEW` for that reviewer with the raw
   output attached under `debug`, and exit 2. Never guess at the model's intent.

Additionally, request the schema in the prompt as a rendered JSON Schema, not prose.
Malformed output is overwhelmingly a prompt problem, and `panel doctor` should report
schema-failure rate per reviewer so it is visible when a prompt regresses.

---

## 6. Execution model

```
panel
  │
  ├─ resolve repo root, load .review/, validate config          (~50ms)
  ├─ compute diff vs merge-base(origin/main, HEAD)
  ├─ filter rule catalog by applies_to/exceptions against changed paths
  ├─ check cache: (file_hash + ruleset_hash + reviewer + model) → memoized report
  │
  ├─ TIER 0 — sequential, fail fast
  │    lint → typecheck → test:affected → build
  │    any failure → print, exit 4, spend nothing
  │
  ├─ TIER 1 — parallel fan-out, bounded by max_parallel
  │    architecture · security · testing · company-standards
  │    each: one `claude -p` subprocess, isolated, no shared state
  │
  ├─ TIER 2 — parallel, advisory
  │    performance · maintainability · documentation
  │
  ├─ suppression pass: drop findings in baseline.json or dismissals.yaml
  ├─ aggregation: dedupe, detect contradictions, apply thresholds
  └─ render (pretty | json | sarif), write .review-report.json, exit
```

### 6.1 Reviewer invocation

One subprocess per reviewer:

```bash
claude -p \
  --output-format json \
  --model "$MODEL" \
  --allowed-tools "Read,Grep,Glob" \
  --permission-mode dontAsk \
  --max-turns 12 \
  < "$COMPILED_PROMPT"
```

The prompt is assembled by the orchestrator from: reviewer persona → filtered rule
catalog → context documents → the diff → the JSON schema. The diff is delimited and
explicitly labelled as untrusted data (§8).

Reviewers are given `Read`, `Grep`, and `Glob` so they can pull the surrounding file
and immediate call sites when the diff alone is ambiguous — an architecture reviewer
that cannot see the class a method belongs to produces noise. They are **never** given
`Write`, `Edit`, `Bash`, or network tools.

### 6.2 Independence

Reviewers run in separate processes with no shared conversation and never see each
other's output. This is deliberate: a reviewer that sees "Security: PASS" anchors on the
code being broadly fine. Independence is also what makes disagreement meaningful — if
two reviewers contradict each other, that is signal for a human, not noise to resolve
by having one defer to the other.

### 6.3 Aggregation

The aggregator is **deterministic code, not a model call**, for v1:

1. **Dedupe** — findings with identical `id` from different reviewers collapse to one,
   keeping the highest severity and listing all reporting reviewers.
2. **Contradiction detection** — two findings on overlapping line spans with opposing
   `rule.direction` metadata (e.g. `extract` vs `inline`). Escalate to
   `NEEDS_HUMAN_REVIEW`.
3. **Confidence gate** — a finding from a blocking reviewer below that reviewer's
   `min_confidence_to_block` is demoted to advisory, not dropped. It still prints.
4. **Severity gate** — `FAIL` if any surviving blocking finding is at or above
   `fail_on_severity`.

A "Chief Reviewer" model pass that synthesizes prose from the specialist findings is
attractive and should be **deferred to v2**. It adds latency and cost to the critical
path, and it can only be evaluated once you have ground truth about what the specialists
get wrong. Ship deterministic aggregation, collect data, then decide whether synthesis
earns its place.

---

## 7. Local integration

### Slash command (primary interface)

`.claude/commands/review.md` invokes `panel --tier 1` and renders results inline. This
is what engineers use mid-work, in the session where they can fix findings immediately.
The hook is a backstop, not the front door.

### Pre-push hook

Managed by `lefthook` so it is version-controlled and installed by `npm ci`:

```yaml
# lefthook.yml
pre-push:
  commands:
    panel:
      run: panel --tier 1 --format pretty
      fail_text: "Review failed. Fix, or override with: git push --no-verify"
```

Pre-push, not pre-commit: WIP commits produce noise, and the branch diff is the unit a
reviewer can reason about.

### Escape hatch

`--no-verify` stays available and is deliberately advertised in the failure message. A
gate engineers cannot bypass gets bypassed structurally instead — by batching pushes,
by squashing everything into one commit at the end — and those workarounds cost more
than the occasional skipped review. Track bypass rate rather than preventing it; a
rising rate is the metric that tells you a rule has become noise.

---

## 8. Security model

Diff content is **untrusted input**. A reviewer reads code written by whoever opened the
branch, including forks and dependency bots.

- Reviewers get read-only tools. No `Write`, no `Edit`, no `Bash`, no network access.
- Prompt boundary: the diff is wrapped in delimiters and preceded by an explicit
  instruction that content inside is data to be analyzed, never instructions to follow.
  Text inside a diff claiming to be from the team lead does not change the rules.
- Sanitize before prompting: strip HTML comments, zero-width characters, and
  bidirectional-override characters from diff content.
- Path confinement: reviewers may only `Read` within the repo root. Reads of `.env`,
  `.git/config`, `**/credentials*`, and anything in `.gitignore` are denied at the
  tool-permission layer.
- Secret handling: the diff is sent to the model API. If your repo can contain secrets
  in a diff, run a deterministic secret scanner in tier 0 and abort before any reviewer
  sees the content.
- `panel doctor` verifies no reviewer config has escalated its `allowed_tools` beyond
  the read-only set, and fails if one has. Reviewer definitions are code review targets
  like any other file.

---

## 9. CI relationship

CI runs the same `panel` binary at the same pinned version against the same `.review/`.

**Local results are a cache, not an authority.** A report file produced on a developer
machine could have been hand-edited. CI therefore:

1. Reads `.review-report.json` if attached to the PR.
2. Accepts it only if `commit`, `ruleset_hash`, and `config_hash` all match what CI
   computes independently, and the schema validates.
3. On match, republishes it as the check run without re-reviewing — saving the cost.
4. On any mismatch, re-runs from scratch.

The permissions for the CI job stay minimal: `contents: read` and `pull-requests: write`.
Granting `contents: write` would let a prompt-injected reviewer push to the branch.

Anything that genuinely gates merge must be re-derivable in an environment the author
does not control. The local pass exists to make CI fast and rarely surprising, not to
replace it.

---

## 10. Adoption mechanics

These are the parts that decide whether the system survives contact with a real team.
They matter more than the reviewer prompts.

### 10.1 Baseline

`panel --baseline` reviews the current `HEAD` and records every finding into
`baseline.json`. Those findings are suppressed by default thereafter. Without this, day
one of a seven-reviewer rollout surfaces four thousand findings in existing code and the
tool is disabled by the end of the week.

Baseline entries are keyed by stable finding ID (§5.3), so touching the offending code
un-suppresses it — new work is held to the standard, legacy code is grandfathered until
someone edits it. Report baseline size as a burn-down metric.

### 10.2 Dismissals

```yaml
# .review/dismissals.yaml
- id: a3f9c1e2
  rule: ARCH-012
  reason: "Intentional — this endpoint predates the service layer, tracked in ARCH-441."
  approved_by: "@jsmith"
  expires: "2026-12-31"
```

Committed, code-reviewed, and expiring. An expired dismissal reactivates the finding.
`panel doctor` warns on dismissals expiring within 30 days and on dismissal counts that
have grown faster than the codebase — a rule with fifty dismissals is a broken rule, not
fifty exceptional cases.

### 10.3 Rule promotion via evaluation

No rule enters the blocking tier on intuition. `.review/fixtures/` holds golden diffs
labelled as violating or compliant per rule. `panel eval` scores the catalog:

| Metric | Threshold to promote `status: proposed` → `active` + `blocking: true` |
|--------|---|
| Precision | ≥ 0.90 over ≥ 20 real diffs |
| Recall | ≥ 0.70 on labelled fixtures |
| Dismissal rate | < 10% over the last 30 days in advisory mode |

New rules ship as advisory. They print, they are counted, they block nothing. A rule
earns blocking status with data. This single policy is the difference between a system
engineers respect and one they route around.

### 10.4 Telemetry

Each run appends to `.review/cache/metrics.jsonl` (local, gitignored) and, if a
collector is configured, to a central store: rule ID, fired/dismissed, reviewer,
duration, cost, schema-failure rate, bypass events. The monthly question this answers is
"which rules are earning their keep?" — and rules that fire constantly but are always
dismissed get deleted, not tuned.

---

## 11. Deliberate deferrals

| Deferred | Why | Revisit when |
|---|---|---|
| Chief Reviewer synthesis pass | Latency and cost on the critical path; unevaluable without ground truth | Specialist false-positive rates are measured |
| Agent SDK orchestration | `claude -p` subprocesses are sufficient for 7 reviewers | You need guaranteed invocation, per-reviewer hooks, or fine-grained cost control |
| Incremental re-review of a fixed finding | Complex cache invalidation | Median run time exceeds 90s |
| Cross-PR architectural drift detection | Needs a persistent index, different problem shape | The rule catalog is stable |
| Auto-fix / suggested patches | Requires write permissions, changes the security model entirely | Never, without a separate design |

---

## 12. Open questions

1. **Diff granularity.** Whole changed files, or hunks plus resolved call sites? Hunks
   are cheaper; architecture review specifically needs more context than a hunk. Likely
   per-reviewer configuration, decided by measurement.
2. **Monorepo scoping.** Does a change in `packages/core` trigger reviewers configured
   in `packages/api`? Proposed: no, unless a dependency edge is declared.
3. **Cost attribution.** Per-engineer, per-repo, or pooled? Affects whether `max_cost`
   is a hard stop or a warning.
4. **Model pinning.** Pinning exact model versions makes results reproducible but leaves
   capability on the table. Suggest pinning in `config.yaml` and treating a model bump
   as a change that requires re-running `panel eval`.
5. **Naming.** `panel` collides with nothing common on PATH but is generic. Alternatives:
   `revu`, `committee`, `<company>-review`.

---

## 13. Milestones

**M1 — walking skeleton (1 week).** `panel init`, config loading, diff computation, one
reviewer (security), schema validation with retry, pretty output, exit codes. Prove the
JSON contract holds on real diffs before building anything else on top of it.

**M2 — the committee (1 week).** Remaining six reviewers, parallel execution, cost caps,
deterministic aggregation, tier 0 integration.

**M3 — adoption (1 week).** Baseline, dismissals, slash command, lefthook, `doctor`.

**M4 — CI (1 week).** GitHub Action, report verification, SARIF output, check runs.

**M5 — evidence.** `panel eval`, fixtures, telemetry, first promotion of an advisory
rule to blocking based on measured precision.

Do not start M2 until a single reviewer has run against fifty real diffs and you have
looked at every finding it produced. The rule catalog is the product; the orchestrator
is plumbing.
