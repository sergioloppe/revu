# Authoring rules and reviewers

The rule catalog is the product. `revu`'s orchestrator is plumbing — the value
lives in the rules you write in `.review/`. This guide covers how to write a
rule, how to write a reviewer persona, and how to evolve the catalog safely.

See also: [`HOWTO.md`](../HOWTO.md) for the end-to-end workflow,
[`docs/configuration.md`](configuration.md) for the `config.yaml` reference.

---

## The model: reviewers, rules, tiers

- A **reviewer** is a persona with a narrow scope (security, architecture, …). It
  is one `claude -p` subprocess with a system prompt and a filtered slice of the
  catalog. It only reports violations of rules it was given.
- A **rule** is one markdown file. Its frontmatter is the machine contract; its
  body is the prompt fragment the reviewer reads.
- A **tier** decides whether a reviewer can block. Tier 1 = blocking committee;
  tier 2 = advisory (findings print and count but never fail the run).

A reviewer is matched to rules by the `rules:` glob in `config.yaml` (e.g.
`rules/security/**`), evaluated against each rule file's path. A rule is matched
to a diff by its own `applies_to`/`exceptions` globs, evaluated against changed
file paths — **before** the reviewer runs, so irrelevant rules are never even
loaded into the prompt.

---

## Anatomy of a rule file

`.review/rules/<domain>/<RULE-ID>.md`:

```markdown
---
id: ARCH-012
title: No business logic in controllers
domain: architecture
severity: high            # critical | high | medium | low
blocking: false           # proposed rules should NOT block yet
status: proposed          # proposed | active | deprecated | disabled
since: "2026-07-20"       # optional, informational
applies_to:
  - "src/**/*Controller.ts"
exceptions:
  - "src/health/**"
  - "src/**/*.legacy.ts"
---

Controllers translate between transport and the domain. They may validate input
shape, call exactly one application service, and map the result to a response.
They may not branch on domain state, perform calculations, or orchestrate
multiple services.

## Violating

```ts
// OrderController.ts
if (order.total > 1000 && user.tier === 'basic') {
  order.requiresApproval = true;   // a domain decision made in the controller
}
```

## Compliant

```ts
const order = await this.orderService.submit(dto, user);
```

## How to fix

Move the decision into the domain service or the aggregate that owns the
invariant.
```

### Frontmatter fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique across the effective catalog. Convention: `DOMAIN-NNN` (e.g. `SEC-003`). Findings are cited by this id. |
| `title` | recommended | One-line human name. |
| `domain` | recommended | Groups the rule; usually matches the folder and reviewer. |
| `severity` | yes | `critical` \| `high` \| `medium` \| `low`. Compared against `aggregation.fail_on_severity`. |
| `blocking` | yes | Whether a finding *can* fail the run (only ever does for tier-1 reviewers at/above the severity gate and confidence threshold). |
| `status` | yes | `proposed` (advisory, still maturing) · `active` (in force) · `deprecated` (excluded from runs) · `disabled` (removes an inherited/global rule). |
| `since` | no | Informational date. |
| `applies_to` | no | Globs; the rule loads only when a changed file matches one. Defaults to everything (`**`). |
| `exceptions` | no | Globs; a matching file is excluded even if `applies_to` matched. Merged (unioned) with a global rule's exceptions when a repo rule overrides it. |

### Body structure

The body is free-form markdown, but the **Violating / Compliant / How to fix**
shape is what makes reviewers accurate. Give a concrete positive and negative
example in the language you actually use. Reviewers are told to report a
violation *only* when they can cite a rule id from the catalog — so the clearer
the rule, the less noise.

---

## Writing a good rule

1. **One rule, one invariant.** If a rule needs "and also…", split it. Findings
   should map to a single, fixable thing.
2. **Make it decidable.** A reviewer should be able to tell violating from
   compliant code from the diff plus the immediate surrounding file (it has
   `Read`/`Grep`/`Glob`). "Code should be clean" is not a rule; "controllers may
   not call more than one application service" is.
3. **Scope with `applies_to`.** A rule that can't apply to a file in the diff is
   never loaded — this is the biggest cost lever. Target the real file patterns.
4. **Show, don't just tell.** The Violating/Compliant examples do more work than
   the prose.
5. **Start advisory.** New rules ship `status: proposed`, `blocking: false`. They
   earn blocking status with evidence (see "Promotion" below).
6. **Pick severity honestly.** `fail_on_severity` (default `high`) is the gate. A
   `low`/`medium` rule prints but won't fail the run even when blocking.

### Confidence and blocking

A tier-1 finding blocks only when **all** of these hold: the rule is `blocking:
true`, its severity is at or above `aggregation.fail_on_severity`, and the
reviewer's confidence is at or above that reviewer's `min_confidence_to_block`
(in `config.yaml`). A high-stakes reviewer like `security` deliberately sets a
*lower* threshold (e.g. `0.70`) because a false negative costs more than a false
positive. Findings below the confidence bar are demoted to advisory, not dropped
— they still print.

---

## Anatomy of a reviewer persona

`.review/reviewers/<id>.md`:

```markdown
---
id: architecture
name: Architecture Reviewer
---

You review changes for architectural integrity only.

You do NOT comment on: formatting, naming, test coverage, documentation,
performance, or security. Other reviewers own those. Reporting outside your
domain is an error.

Report a violation only when you can cite a rule ID from the catalog below. If
code looks wrong but no rule covers it, do not report it — open a pull request
against the rule catalog instead.
```

The **negative scope** ("you do NOT comment on…") matters more than the positive
framing. Without it, every reviewer drifts toward generic code review and you
pay N times for one opinion. Keep each persona tightly boxed.

To add a reviewer: create the persona file, then add an entry in `config.yaml`
`reviewers:` with its `id`, `tier`, and `rules:` glob. To point it at extra
context docs (kept small — they're paid for on every run), list them under that
reviewer's `context:`.

---

## Testing rules before you trust them

`revu` gives you the raw material to evaluate a rule empirically:

- Run `revu --only <reviewer>` against real branches and read the findings.
- The JSON envelope (`.review-report.json`) records every finding, its
  confidence, and cost — diff it across runs.
- Watch the dismissal rate. A rule dismissed most times it fires is noise.

### Promotion checklist (proposed → active + blocking)

Flip a rule to `blocking: true`, `status: active` only once it clears a bar you
trust — the design suggests, per rule:

| Signal | Rough bar |
|---|---|
| Precision on real diffs | ≥ 0.90 over ≥ 20 diffs |
| Recall on known cases | ≥ 0.70 |
| Dismissal rate in advisory mode | < 10% over the last 30 days |

You don't have automated `eval` tooling in v1 (that's M5) — this is a judgment
call informed by reading findings. The point stands: **no rule enters the
blocking tier on intuition.**

---

## Global vs. repo rules

You can keep a personal/company catalog in `~/.config/revu/` (scaffold it with
`revu init --global`) and reuse it across projects. The cascade merges it under
each repo's `.review/`:

- A repo rule sharing an id **replaces** the global one; a repo rule with only
  `status: disabled` **turns a global one off**; `exceptions` are unioned.
- **Global-sourced rules are always advisory** — they never block, even with
  `blocking: true`, so CI (which has no `~/.config/revu/`) stays reproducible.
  `revu doctor` flags a global rule that declares `blocking: true`.
- To make a global rule blocking-eligible in a repo, run `revu config promote
  <RULE-ID>` — it copies the file into `.review/rules/<domain>/`, taking local
  ownership.

Inspect the merged result any time with `revu config show --effective`.

---

## Keeping the catalog healthy

- `revu rules lint` — validates frontmatter and flags duplicate ids.
- `revu doctor` — the above plus persona/reviewer wiring, expiring dismissals,
  and global-blocking mismatches.
- Delete rules that fire and get dismissed. A rule with fifty dismissals is a
  broken rule, not fifty exceptions.
- Deprecate rather than delete when you want a paper trail: `status: deprecated`
  excludes it from runs but keeps the file.
