# Configuration reference

Everything `revu` reads lives in `.review/` at the repo root — one `config.yaml`
plus the rule/reviewer/context files around it. This document is the field-level
reference for `config.yaml` and the config cascade. For writing rules see
[`docs/authoring-rules.md`](authoring-rules.md); for the workflow see
[`HOWTO.md`](../HOWTO.md).

---

## The cascade

Four layers, lowest to highest precedence, merged by key (and rules/reviewers by
`id`):

```
1. Built-in defaults    shipped inside the revu package
2. Global config         ~/.config/revu/   ($REVU_CONFIG_HOME overrides the dir)
3. Repo config            .review/ at the repo root — committed, reviewed like code
4. Workspace config       nearest .review/ in a monorepo (extends the repo root)
```

- Scalars merge key-by-key; the higher layer wins.
- `reviewers` merge by `id`; a higher-layer entry with the same id replaces the
  lower one.
- Rules merge by `id` across `rules/` directories (see authoring guide).
- `inherit_global: false` in a repo's `config.yaml` opts that repo out of the
  global layer entirely.
- **Global-sourced rules are always advisory** so behavior can't depend on a
  machine-local `~/.config/revu/` that CI doesn't have.

Inspect the merged result with `revu config show --effective` (it prints a
`# layers: …` provenance header).

The effective config plus the active ruleset are hashed into `config_hash` /
`ruleset_hash` in every report envelope, so a run's result is tied to exactly the
config that produced it.

---

## `.review/config.yaml` — full reference

```yaml
schema_version: 1               # required, currently always 1

# inherit_global: true          # set false to ignore ~/.config/revu/ entirely

defaults:
  model: claude-sonnet-5        # default model for reviewers that don't override it
  timeout_seconds: 120          # per-reviewer subprocess timeout
  max_output_tokens: 4000       # per-reviewer output cap

auth:
  mode: auto                    # auto | subscription | api_key
  # max_cost_usd_per_run: 1.50  # hard stop, ENFORCED only in api_key mode

# Tier 0: deterministic pre-checks, run sequentially. Every check runs — a failure
# does not stop the ones after it. A failing `blocking: true` check (the default)
# fails the run with exit 4 before any reviewer is spawned; a failing
# `blocking: false` check is reported and the review continues.
# tiers:
#   "0":
#     checks:
#       - id: typecheck
#         command: npx tsc --noEmit
#         timeout_seconds: 120
#       - id: lint
#         command: npx eslint .
#         blocking: false       # reported, never gates

reviewers:
  - id: security
    tier: 1                     # 1 = blocking committee, 2 = advisory only
    rules: rules/security/**    # glob selecting this reviewer's rules
    model: claude-opus-4-8      # optional per-reviewer model override
    min_confidence_to_block: 0.70
    # context:                  # optional extra docs injected into this reviewer
    #   - context/threat-model.md

aggregation:
  fail_on_severity: high        # critical | high | medium | low
  max_parallel: 4               # max reviewers running concurrently

# Opt-in: inject an installed Claude Code skill's SKILL.md into named reviewers
# context:
#   skills:
#     - source: superpowers                 # skill set under ~/.claude/skills
#       include: [test-driven-development]   # which skills' SKILL.md to inject
#       reviewers: [testing]                 # into which reviewers' prompts only
```

### Top-level fields

| Field | Default | Meaning |
|---|---|---|
| `schema_version` | — (required) | Config format version; always `1`. |
| `inherit_global` | `true` | When `false`, the global `~/.config/revu/` layer is skipped. |
| `defaults` | see below | Fallback model / timeout / output cap for reviewers. |
| `auth` | `{ mode: auto }` | Auth-mode selection and the (api-key-only) cost cap. |
| `tiers` | none | Deterministic pre-checks; see Tier 0 below. |
| `reviewers` | `[]` | The committee. |
| `aggregation` | see below | How findings become a verdict. |
| `context` | `{ skills: [] }` | Opt-in skill-set context injection. |

### `defaults`

| Field | Default | Meaning |
|---|---|---|
| `model` | `claude-sonnet-5` | Model used by a reviewer without its own `model`. |
| `timeout_seconds` | `120` | Per-reviewer subprocess timeout; on hit the reviewer becomes `NEEDS_HUMAN_REVIEW`. |
| `max_output_tokens` | `4000` | Per-reviewer output cap. |

### `auth`

| Field | Default | Meaning |
|---|---|---|
| `mode` | `auto` | `auto` detects `ANTHROPIC_API_KEY` (→ `api_key`) vs a Claude Code subscription login (→ `subscription`). Force either explicitly if needed. |
| `max_cost_usd_per_run` | none | A hard stop, **enforced only in `api_key` mode**. In subscription mode it is ignored (spend rides your plan) but cost is still reported. |

### `reviewers[]`

| Field | Default | Meaning |
|---|---|---|
| `id` | — (required) | Reviewer id; must have a matching `reviewers/<id>.md` persona. |
| `tier` | — (required) | `1` (can block) or `2` (advisory only — never fails the run). |
| `rules` | — (required) | Glob selecting this reviewer's rule files, e.g. `rules/security/**`. |
| `model` | `defaults.model` | Per-reviewer model override (use cheaper models for mechanical reviewers). |
| `min_confidence_to_block` | `0.85` | A tier-1 finding below this confidence is demoted to advisory (still printed). |
| `context` | `[]` | Extra doc paths injected into this reviewer's prompt. Keep small — paid per run. |

### `aggregation`

| Field | Default | Meaning |
|---|---|---|
| `fail_on_severity` | `high` | The run fails on a surviving blocking finding at or above this severity. |
| `max_parallel` | `4` | Maximum reviewers running at once during the fan-out. |

### `tiers."0".checks[]`

| Field | Default | Meaning |
|---|---|---|
| `id` | — (required) | Label for the check in output and the envelope. |
| `command` | — (required) | Shell command. **Runs with your privileges — see the trust boundary below.** |
| `timeout_seconds` | none | Kills the check (and its process group) after this long; a timeout fails tier 0. |

> **Tier-0 trust boundary.** `command` entries are arbitrary shell commands
> executed on the host with the privileges of whoever runs `revu` — they are
> *not* covered by the reviewer no-write guarantee (no sandbox, no read-only
> tools, no git-state assertion). Treat `.review/config.yaml` as trusted code:
> never run `revu` against config you don't trust, and review changes to tier-0
> `command`s as carefully as CI scripts.

### `context.skills[]` (opt-in)

Injects an installed Claude Code skill's `SKILL.md` content into specific
reviewers' prompts — e.g. feed your `test-driven-development` skill to the
`testing` reviewer so it judges diffs against the discipline you actually work
by. Reviewers never gain the `Skill` *tool*; this is context text only.

| Field | Meaning |
|---|---|
| `source` | A skill set discoverable under `~/.claude/skills` (or `$REVU_SKILLS_HOME`). |
| `include` | Which skills' `SKILL.md` files to inject. |
| `reviewers` | Which reviewers receive them (and only those). |

Skill content is folded into `config_hash`, so editing a skill invalidates the
review cache and shows up as config drift. A configured-but-missing skill is a
`revu doctor` warning, not a failure — it's skipped at run time.

---

## Environment variables

| Variable | Effect |
|---|---|
| `REVU_CONFIG_HOME` | Overrides the global config dir (default `~/.config/revu`). |
| `REVU_SKILLS_HOME` | Overrides where skill-set injection looks (default `~/.claude/skills`). |
| `REVU_CLAUDE_BIN` | Path to the `claude` binary (default `claude` on PATH). |
| `ANTHROPIC_API_KEY` | Its presence switches auth to `api_key` mode (enables the USD cap). |

---

## Files revu reads and writes

| Path | Role |
|---|---|
| `.review/config.yaml` | The one settings file (this document). |
| `.review/reviewers/<id>.md` | Reviewer personas. |
| `.review/rules/<domain>/*.md` | The rule catalog. |
| `.review/context/*` | Optional context docs referenced by `reviewers[].context`. |
| `.review/baseline.json` | Grandfathered findings (written by `revu --baseline`). |
| `.review/dismissals.yaml` | Time-boxed, approved suppressions (written by `revu --dismiss`). |
| `.review/cache/` | Memoized reviews (git-ignored). |
| `.review-report.json` | The full envelope from the last run (repo root). |
| `lefthook.yml` | Pre-push hook (repo root; written by `revu init` if absent). |
