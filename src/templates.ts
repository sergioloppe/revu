export const TEMPLATES: Record<string, string> = {
  'config.yaml': `schema_version: 1

defaults:
  model: claude-sonnet-5
  timeout_seconds: 120

# auth.mode: auto (default) detects ANTHROPIC_API_KEY vs Claude Code subscription login.
# max_cost_usd_per_run is only enforced in api_key mode.
auth:
  mode: auto

# Tier 0: deterministic pre-checks (lint, typecheck, ...) that run before any
# reviewer spends a token. Sequential, fail-fast — the first non-zero exit (or
# timeout) fails the whole run with exit code 4 and no reviewer is spawned.
# tiers:
#   "0":
#     checks:
#       - id: typecheck
#         command: npx tsc --noEmit
#         timeout_seconds: 120
#       - id: lint
#         command: npx eslint .

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

  - id: maintainability
    tier: 2
    rules: rules/maintainability/**
    model: claude-haiku-4-5

  - id: documentation
    tier: 2
    rules: rules/documentation/**
    model: claude-haiku-4-5

aggregation:
  fail_on_severity: high
  max_parallel: 4
`,

  'reviewers/architecture.md': `---
id: architecture
name: Architecture Reviewer
---

You review changes for architectural integrity only.

You do NOT comment on: security, test coverage, company style/naming
conventions, performance, maintainability, or documentation. Other reviewers
own those. Reporting outside your domain is an error.

Report a violation only when you can cite a rule ID from the catalog you are
given. If code looks wrong but no rule covers it, do not report it.
`,

  'reviewers/security.md': `---
id: security
name: Security Reviewer
---

You review changes for security vulnerabilities only.

You do NOT comment on: formatting, naming, architecture, test coverage,
documentation, or performance. Other reviewers own those. Reporting outside
your domain is an error.

Report a violation only when you can cite a rule ID from the catalog you are
given. If code looks wrong but no rule covers it, do not report it.
`,

  'reviewers/testing.md': `---
id: testing
name: Testing Reviewer
---

You review changes for test coverage and test quality only.

You do NOT comment on: architecture, security, company style/naming
conventions, performance, maintainability, or documentation. Other reviewers
own those. Reporting outside your domain is an error.

Report a violation only when you can cite a rule ID from the catalog you are
given. If code looks wrong but no rule covers it, do not report it.
`,

  'reviewers/company-standards.md': `---
id: company-standards
name: Company Standards Reviewer
---

You review changes for adherence to house naming, formatting, and API
conventions only.

You do NOT comment on: architecture, security, test coverage, performance,
maintainability, or documentation content. Other reviewers own those.
Reporting outside your domain is an error.

Report a violation only when you can cite a rule ID from the catalog you are
given. If code looks wrong but no rule covers it, do not report it.
`,

  'reviewers/performance.md': `---
id: performance
name: Performance Reviewer
---

You review changes for performance regressions only.

You do NOT comment on: architecture, security, test coverage, company
style/naming conventions, maintainability, or documentation. Other reviewers
own those. Reporting outside your domain is an error.

Report a violation only when you can cite a rule ID from the catalog you are
given. If code looks wrong but no rule covers it, do not report it.
`,

  'reviewers/maintainability.md': `---
id: maintainability
name: Maintainability Reviewer
---

You review changes for long-term maintainability and complexity only.

You do NOT comment on: architecture-level integrity, security, test
coverage, company style/naming conventions, performance, or documentation.
Other reviewers own those. Reporting outside your domain is an error.

Report a violation only when you can cite a rule ID from the catalog you are
given. If code looks wrong but no rule covers it, do not report it.
`,

  'reviewers/documentation.md': `---
id: documentation
name: Documentation Reviewer
---

You review changes for missing or stale documentation only.

You do NOT comment on: architecture, security, test coverage, company
style/naming conventions, performance, or maintainability. Other reviewers
own those. Reporting outside your domain is an error.

Report a violation only when you can cite a rule ID from the catalog you are
given. If code looks wrong but no rule covers it, do not report it.
`,

  'rules/security/SEC-001.md': `---
id: SEC-001
title: No dynamic code execution on user input
domain: security
severity: critical
blocking: false
status: proposed
applies_to:
  - "**/*.ts"
  - "**/*.js"
---

Never pass user-controlled data to \`eval\`, \`new Function\`, or dynamic
\`import()\` expressions built from strings.

## Violating

\`\`\`ts
const result = eval(req.body.expression);
\`\`\`

## Compliant

\`\`\`ts
const result = safeEvaluate(parse(req.body.expression));
\`\`\`

## How to fix

Parse the input into a restricted AST or use a sandboxed interpreter.
`,

  'rules/security/SEC-002.md': `---
id: SEC-002
title: No hardcoded secrets
domain: security
severity: high
blocking: false
status: proposed
applies_to:
  - "**"
exceptions:
  - "**/*.test.*"
  - "**/fixtures/**"
---

Credentials, API keys, and tokens must come from the environment or a secret
manager, never from source.

## Violating

\`\`\`ts
const apiKey = "sk-live-4f9a...";
\`\`\`

## Compliant

\`\`\`ts
const apiKey = process.env.PAYMENT_API_KEY;
\`\`\`

## How to fix

Move the value to the environment; rotate the leaked credential.
`,

  'rules/architecture/ARCH-001.md': `---
id: ARCH-001
title: No business logic in controllers
domain: architecture
severity: high
blocking: false
status: proposed
applies_to:
  - "src/**/*Controller.ts"
exceptions:
  - "**/*.test.*"
---

Controllers translate between transport and the domain. They may validate
input shape, call exactly one application service, and map the result to a
response. They may not branch on domain state, perform calculations, or
orchestrate multiple services.

## Violating

\`\`\`ts
// OrderController.ts
if (order.total > 1000 && user.tier === 'basic') {
  order.requiresApproval = true;   // domain decision made in the controller
}
\`\`\`

## Compliant

\`\`\`ts
const order = await this.orderService.submit(dto, user);
\`\`\`

## How to fix

Move the decision into the domain service or the aggregate that owns the
invariant.
`,

  'rules/testing/TEST-001.md': `---
id: TEST-001
title: No skipped tests without a tracking reference
domain: testing
severity: medium
blocking: false
status: proposed
applies_to:
  - "**/*.test.*"
  - "**/*.spec.*"
---

\`it.skip\`/\`describe.skip\`/\`test.skip\` (and xit/xdescribe) must carry a
comment linking to a tracking issue explaining why the test is disabled.

## Violating

\`\`\`ts
it.skip('retries on network failure', () => { /* ... */ });
\`\`\`

## Compliant

\`\`\`ts
// Skipped: flaky under CI load, see JIRA-1234.
it.skip('retries on network failure', () => { /* ... */ });
\`\`\`

## How to fix

Either fix the test, delete it, or annotate it with the tracking reference.
`,

  'rules/company-standards/STD-001.md': `---
id: STD-001
title: Exported functions use camelCase
domain: company-standards
severity: low
blocking: false
status: proposed
applies_to:
  - "src/**/*.ts"
---

Exported function and method names follow camelCase, matching the rest of
the codebase's public API surface.

## Violating

\`\`\`ts
export function Get_User(id: string) { /* ... */ }
\`\`\`

## Compliant

\`\`\`ts
export function getUser(id: string) { /* ... */ }
\`\`\`

## How to fix

Rename the export and update call sites.
`,

  'rules/performance/PERF-001.md': `---
id: PERF-001
title: No synchronous I/O on the request path
domain: performance
severity: high
blocking: false
status: proposed
applies_to:
  - "src/**/*.ts"
exceptions:
  - "**/*.test.*"
  - "scripts/**"
---

Blocking, synchronous filesystem or network calls (e.g. \`readFileSync\`,
\`execSync\`) on a request-handling path stall the event loop for every
concurrent request.

## Violating

\`\`\`ts
app.get('/config', (req, res) => {
  res.json(JSON.parse(readFileSync('config.json', 'utf8')));
});
\`\`\`

## Compliant

\`\`\`ts
app.get('/config', async (req, res) => {
  res.json(JSON.parse(await readFile('config.json', 'utf8')));
});
\`\`\`

## How to fix

Use the async variant of the API, or move the work off the request path.
`,

  'rules/maintainability/MAINT-001.md': `---
id: MAINT-001
title: Functions stay under a manageable complexity budget
domain: maintainability
severity: medium
blocking: false
status: proposed
applies_to:
  - "src/**/*.ts"
exceptions:
  - "**/*.test.*"
---

A function with many nested conditionals and branches is hard to review,
test, and change safely. Prefer extracting named helpers or early returns
over deep nesting.

## Violating

\`\`\`ts
function process(order) {
  if (order) {
    if (order.items.length) {
      for (const item of order.items) {
        if (item.qty > 0) {
          if (item.price > 0) { /* ... deeply nested ... */ }
        }
      }
    }
  }
}
\`\`\`

## Compliant

\`\`\`ts
function process(order) {
  if (!order?.items.length) return;
  for (const item of order.items) processItem(item);
}
\`\`\`

## How to fix

Extract nested blocks into named functions and use guard clauses to reduce
nesting depth.
`,

  'rules/documentation/DOC-001.md': `---
id: DOC-001
title: Exported public APIs carry a doc comment
domain: documentation
severity: low
blocking: false
status: proposed
applies_to:
  - "src/**/*.ts"
exceptions:
  - "**/*.test.*"
  - "**/internal/**"
---

Every exported function, class, or type that forms part of the package's
public API needs a doc comment describing its purpose, parameters, and
return value.

## Violating

\`\`\`ts
export function computeDiscount(order: Order): number { /* ... */ }
\`\`\`

## Compliant

\`\`\`ts
/** Computes the order-level discount in the account's currency. */
export function computeDiscount(order: Order): number { /* ... */ }
\`\`\`

## How to fix

Add a doc comment above the export summarizing intent and contract.
`,
};
