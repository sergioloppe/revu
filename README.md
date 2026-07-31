# revu

A local-first, multi-reviewer AI code review pipeline built on Claude Code.
`revu` runs a committee of specialist reviewers (`claude -p` subprocesses)
against your diff, each scoped to a narrow rule catalog, and turns their
findings into a single deterministic pass/fail decision. Aggregation,
caching, and gating are all plain TypeScript — models only produce findings,
never the verdict.

## Documentation

- **[HOWTO.md](HOWTO.md)** — step-by-step: install, set up a repo, run your first
  review, baseline/dismiss, tier 0, hooks, troubleshooting.
- **[docs/authoring-rules.md](docs/authoring-rules.md)** — writing rules and
  reviewer personas, and promoting rules with evidence.
- **[docs/configuration.md](docs/configuration.md)** — full `config.yaml` and
  cascade reference.

The rest of this file is a reference-style overview.

## Install

Requires Node.js **>= 20** and the `claude` CLI logged in (Max subscription
or `ANTHROPIC_API_KEY`).

```bash
npm install -g revu   # once published; for now, from a checkout:
git clone https://github.com/sergioloppe/revu.git
cd revu && npm install && npm run build && npm link
```

## Developing revu

`npm link` points the global `revu` at `dist/cli.js`, **not** at the
TypeScript source — so after changing anything under `src/`, run `npm run
build` before the global command reflects it. To skip that loop entirely, run
from source:

```bash
npm run dev -- --working        # tsx src/cli.ts, no build step
npm run dev -- --help           # everything after `--` goes to the CLI
npm run build                   # refresh the global `revu`
npm test                        # 27 files, ~230 tests
npx tsc --noEmit                # typecheck only
```

`npm install` is only needed when dependencies change; a `src/` edit never
requires it.

### Bumping the version

The version lives in **`package.json` only** — `src/version.ts` reads it at
startup, so `revu --version` and the `revu_version` field on every envelope
follow automatically. Never hardcode it anywhere else.

```bash
npm run release:patch   # 0.1.1 → 0.1.2   (bug fixes)
npm run release:minor   # 0.1.1 → 0.2.0   (new flags/features)
npm run release:major    # 0.1.1 → 1.0.0   (breaking changes)
git push --follow-tags
```

Each one runs the test suite (`preversion`), bumps `package.json` +
`package-lock.json`, rebuilds `dist/` (`version`), then commits as
`chore(release): v<x.y.z>` and tags it. To bump the files without the commit
and tag — e.g. to fold the version into a commit you're already writing:

```bash
npm version patch --no-git-tag-version
```

## Quickstart

```bash
cd your-repo
revu init          # detects the language, scaffolds .review/ + lefthook.yml
git add .review lefthook.yml
git commit -m "add revu"

revu                # reviews COMMITS on this branch vs origin/main (or main)
revu --staged       # reviews the staged index instead
revu --working      # reviews every uncommitted change to a tracked file
revu --tier 1       # blocking committee only, skip advisory tier 2
```

Bare `revu` reviews committed work only. On a branch whose changes are still
sitting in the index or the working tree, that diff is legitimately empty —
revu says so, reports what the working tree actually holds, and names the flag
that would review it.

Progress (tier-0 checks, each reviewer as it starts and finishes, plus a
periodic "still running" line) streams to **stderr**; the report goes to
stdout, so `revu --format json > out.json` stays clean. `-q` silences progress.

Everything `revu init` scaffolds is `status: proposed`, non-blocking. Rules
earn `blocking: true` deliberately, once you trust them on real diffs.

## Rule packs

`revu init` installs a starter catalog for the repo's language, detected from
marker files at the repo root:

| Pack | Detected by | Rules | Tier 0 |
|---|---|---|---|
| `go` | `go.mod` | SEC-001/002, REL-001/002/003, ARCH-001, TEST-001, PERF-001, STD-001, DOC-001 | `go build`, `go vet`, `gofmt -l`, `go test` — enabled |
| `laravel` | `artisan` | SEC-001/002/003, ELO-001/002/003/004, ARCH-001, TEST-001, PERF-001, STD-001, DOC-001 | `composer validate`, Pint (skipped if absent), `php artisan test` — enabled; Larastan commented out |
| `ts` | `package.json`, `tsconfig.json` | SEC-001/002, ARCH-001, TEST-001, STD-001, PERF-001, MAINT-001, DOC-001 | commented out (tooling varies) |

```bash
revu init                  # detect from the repo
revu init --lang go        # choose explicitly
revu init --lang laravel
```

The `laravel` pack replaces the `maintainability` reviewer with **`eloquent`** at
tier 1, so data-access findings — N+1 queries, mass assignment, raw-query
injection, irreversible migrations — can block a merge. Filing N+1 under the
tier-2 `performance` reviewer would make the most common Laravel defect advisory
only.

Detection returns nothing when no marker is found **or when several match** — an
ambiguous repo must not silently get a catalog that doesn't apply to it. In that
case revu falls back to the `ts` pack and the coverage check below tells you.

The one exception is a pack that explicitly outranks another. A Laravel app ships
`package.json` for its asset pipeline, which would otherwise read as a tie with
the `ts` pack; `laravel` declares that it beats `ts`, so an `artisan` file
resolves the repo to Laravel rather than to nothing.

### The catalog must actually match the repo

A rule scoped to `src/**/*.ts` in a Go repo isn't quiet, it's **dead**: it is
filtered out of every run, its reviewer is skipped for having no applicable rules,
and the run reports PASS. That is indistinguishable from a clean review, which is
how a team can adopt revu, watch it go green for months, and never learn it
reviewed nothing.

So `revu init` and `revu doctor` both check the effective catalog against the files
actually in the repo:

```
[warn] 7 of 8 rule(s) match no file in this repo: ARCH-001, STD-001, … — most of
       the catalog does not apply here, so runs will look clean while reviewing
       almost nothing. This looks like a Go repo — `revu init --lang go` …
```

A few dormant rules are reported as a note (they may cover paths you don't have
yet). A majority is treated as a probable mismatch and names the pack that fits. If
*nothing* matches, `doctor` fails outright. A run where no reviewer had anything to
do also says so rather than claiming "no findings".

## Suggested fixes

Every finding in a code file carries an appliable edit, not just advice:

```
src/a.ts:2 [SEC-001] high - eval of user input
  fix: Parse the input instead of evaluating it.
  suggested change (line 2):
    - eval(input);
    + JSON.parse(input);
```

Reviewers return `fix` as `{ line, line_end, replacement }` — the exact text that
replaces that range — rather than a unified diff, because a model that miscounts a
hunk header produces something unusable, while a line-range replacement can be
checked against the file. revu resolves every fix before it reaches the report and
**discards** any that doesn't hold up: range outside the file, inverted range, a
replacement identical to the current text, or an edit larger than
`MAX_FIX_LINES` (20). The finding survives without it — a fix you can't apply is
worse than none. Surviving fixes appear in `issues[].fix` on the JSON envelope with
the `original` text they replace, so an editor or agent can apply them directly.

Reviewers are told to omit `fix` when a change genuinely can't be a local edit (it
needs a new file, or coordinated edits in several places) and to explain that in
`suggestion` instead.

## Config cascade

Four layers, lowest to highest precedence, merged by rule/reviewer `id`:

```
1. Built-in defaults   shipped inside the revu package
2. Global config        ~/.config/revu/  ($REVU_CONFIG_HOME overrides)
3. Repo config           .review/ at the repo root — committed, reviewed like code
4. Workspace config      nearest .review/ in a monorepo (extends the repo root)
```

A repo rule sharing an id with a global rule overrides it entirely; a repo
`status: disabled` rule turns a global one off. **Global-sourced rules are
always advisory** — they never block, even if they declare `blocking: true`
(`revu doctor` flags the mismatch) — so CI behavior can't depend on a
machine-local `~/.config/revu/` that CI doesn't have. `revu config show
--effective` prints the merged config with a layer-provenance header; `revu
config promote <RULE-ID>` copies a global rule into `.review/rules/` to make
it blocking-eligible.

## Security model

Reviewers can read the diff and the repo; they can never write to either.
Three independent, non-configurable layers enforce it:

1. **Flag layer** — the read-only toolset (`Read,Grep,Glob`) is a compile-time
   constant in the executor. `config.yaml` has no `allowed_tools` key; if one
   is present, config loading fails hard.
2. **Isolation layer** — each subprocess gets a generated `--settings` file
   that disables MCP servers and hooks and ignores the user/project
   `.claude/settings.json`, plus a minimal env allowlist (auth vars, `PATH`,
   `HOME`).
3. **Assertion layer** — `git rev-parse HEAD` and a hash of `git status
   --porcelain` are snapshotted once before the fan-out and re-checked after
   every reviewer exits. Any mutation aborts the whole run with exit 3 and a
   `SECURITY` error naming the offending reviewer.

The `/revu` Claude Code skill may fix findings in your own session, with your
own permissions — that's outside the reviewer boundary and unaffected.

Reviewers are also constrained to the *scope* of the change: the compiled prompt
tells them to judge only what the diff introduces or touches — no pre-existing
problems in unchanged code, no refactors, no follow-on features the author didn't
set out to build.

### Files revu never reads

Credential files are removed from the diff before any prompt is compiled, so their
content never reaches a model, a cache entry, or the report. The list is a
compile-time constant (`SECRET_PATH_DENY`), not config — a config key that could
re-enable them would be the first thing a bad diff edits:

```
.env and .env.*        *.pem *.key *.p12 *.pfx *.jks *.keystore
id_rsa* id_ed25519*    .npmrc .netrc .pypirc .htpasswd
credentials*           *.kubeconfig   secrets.{yaml,yml,json}
```

`.env.example`, `.env.sample`, `.env.template`, and `.env.dist` are exempt — they
carry variable *names*, not values, and rules like "a new env var must appear in
`.env.example` in the same diff" can't be checked without them. The reviewer's own
settings also deny its read tools on these paths, so a reviewer that goes looking
on its own still can't open one. Every withheld path is named on stderr and
recorded in `excluded_paths` on the envelope, so "no findings" is never confused
with "never looked".

revu's own output (`.review-report.json`, `.review/cache/**`, `.review/baseline.json`,
`.review/dismissals.yaml`) is withheld too — a committed report quotes prior findings
verbatim, which would feed last run's results back into this run's prompts.

**What this does not cover:** a credential hardcoded *in source* is still shown to
reviewers, because detecting it is the entire point of a rule like SEC-001. If your
rule catalog or README uses a real password as its "Violating" example, that value
is in every prompt — use an obviously-fake placeholder there.

Dockerfiles, compose files, and CI config are **not** withheld. They're code, and
reviewing them is how revu catches a secret being baked into an image.

### Tier-0 trust boundary

The no-write guarantee above covers Claude Code reviewer subprocesses only.
Tier-0 `checks[].command` entries declared under `tiers."0".checks` in
`.review/config.yaml` are **arbitrary shell commands**, executed directly on
the host with the same privileges as whoever runs `revu` — no sandboxing, no
read-only restriction, no assertion layer. Anyone who can edit
`.review/config.yaml` can run anything `revu` can run. Do **not** run `revu`
against a repo/config you don't trust, and review changes to tier-0 config
the same way you'd review a change to code — a PR that adds or edits a
`checks[].command` deserves at least as much scrutiny as one touching CI
scripts.

## Commands

| Command | Description |
|---|---|
| `revu` | Review the diff (default: merge-base with `origin/main`/`main` vs `HEAD`). Writes `.review-report.json`. |
| `revu init [--global] [--claude]` | Scaffold `.review/` (or `~/.config/revu/` with `--global`); `--claude` also writes the `/revu`, `/revu-rule`, `/revu-triage` Claude Code commands. |
| `revu doctor` | Environment/auth/catalog health checks. Exit 0 (ok) or 3 (problems); warnings never fail it. |
| `revu rules lint` | Frontmatter validation + duplicate-id checks only (subset of `doctor`). |
| `revu config show --effective` | Print the merged config as YAML with a layer-provenance header. |
| `revu config promote <RULE-ID>` | Copy a global rule into `.review/rules/<domain>/`, taking local (blocking-eligible) ownership. |

## Flags

| Flag | Effect |
|---|---|
| `--staged` | Review the staged index instead of the branch diff. |
| `--working` | Review all uncommitted changes to tracked files (`git diff HEAD`) — staged and unstaged. |
| `--range <a...b>` / `--range <a..b>` | Explicit git range. |
| `--files <files...>` | Limit review to these paths. |
| `--only <ids>` | Run exactly these reviewer ids (comma-separated), regardless of tier. |
| `--skip <ids>` | Exclude these reviewer ids. |
| `--tier <n>` | Run reviewers at or below this tier (0, 1, or 2). `--tier 0` runs only the deterministic tier-0 checks — no reviewer spend. |
| `--skip-tier <tiers>` | Skip whole tiers, comma-separated. `--skip-tier 0` bypasses the deterministic checks (useful when a pre-existing failure in code you didn't touch blocks the review); `--skip-tier 2` drops the advisory reviewers. Skipped tiers are printed and recorded in `skipped_tiers` on the envelope, so a PASS can't be mistaken for one that cleared every gate. |
| `--format <pretty\|json>` | Output format. Omitted, it follows the terminal (`pretty` on a TTY, `json` when piped); given explicitly, it wins either way. |
| `--output <path>` | Write the JSON envelope somewhere other than `.review-report.json`. |
| `--no-cache` | Bypass the review cache on read (writes still happen). |
| `--baseline` | Run the pipeline, record every finding to `.review/baseline.json`, and exit 0 regardless of result. |
| `-q, --quiet` | Suppress the progress stream on stderr. |
| `--dismiss <id> --reason "..."` | Append a dismissal for a finding id from the last `.review-report.json` to `.review/dismissals.yaml` (approver = `git config user.name`, expires in 180 days). Refuses if the id isn't in the last report. |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Pass (or pass with tier-2/advisory warnings only) |
| 1 | Blocking finding at or above `aggregation.fail_on_severity` |
| 2 | A reviewer needed a human (schema-validation failure after retry, or timeout) |
| 3 | Tool error: bad config, missing/unauthenticated `claude`, or a reviewer tripped the no-write assertion (`SECURITY`) |
| 4 | A tier-0 deterministic check failed — zero reviewer spend |

## M2/M3 features

- **Full committee** — architecture, security, testing, company-standards
  (tier 1, blocking) plus performance, maintainability, documentation (tier
  2, advisory-only: tier-2 findings can never fail the run).
- **Parallel fan-out** — reviewers run concurrently, bounded by
  `aggregation.max_parallel`; the git-state snapshot is taken once before the
  fan-out and checked after each reviewer so concurrency can't hide a
  mutation. Reports are collected in config order regardless of completion
  order.
- **Tier 0** — sequential, fail-fast deterministic checks (lint, typecheck,
  ...) declared in `config.yaml`'s `tiers."0".checks`; a failure exits 4
  before any reviewer runs.
- **Review cache** — keyed on reviewer + model + ruleset hash + diff hash,
  under `.review/cache/reviews/`. A hit skips the subprocess entirely
  (`cached: true` on the envelope); `NEEDS_HUMAN_REVIEW` results are never
  cached.
- **Baseline & dismissals** — `revu --baseline` snapshots existing findings so
  only new ones fail future runs; `revu --dismiss` records a time-boxed
  (180-day) suppression with a reason and approver. Both show up under the
  envelope's `suppressed` array rather than silently vanishing.
- **`doctor` / `rules lint` / `config show` / `config promote`** — adoption
  and catalog-health tooling (see Commands above).
- **Claude Code integration** — `revu init --claude` installs `/revu`,
  `/revu-rule`, `/revu-triage`; `revu init` also writes a `lefthook.yml`
  pre-push hook (`revu --tier 1`, with a documented `--no-verify` escape
  hatch) if one isn't already present.
- **Skill-set context injection (opt-in)** — `config.yaml`'s `context.skills`
  can inject an installed Claude Code skill's `SKILL.md` content into named
  reviewers' prompts only (e.g. feed `test-driven-development` to the
  `testing` reviewer). Reviewers never gain the `Skill` tool. A missing skill
  file is a `doctor` warning, not a failure; skill content is folded into the
  envelope's `config_hash` so drift is visible.

## Auth

`claude -p` inherits whatever auth your Claude Code login already has —
**Max-subscription-first**: locally, review spend rides your existing plan at
no marginal cost. Set `ANTHROPIC_API_KEY` instead (e.g. in CI) and revu
detects `api_key` mode automatically; `auth.max_cost_usd_per_run` is then
enforced as a hard stop (ignored, but still reported, in subscription mode).
The envelope always records `auth_mode` next to cost so results are
interpreted correctly either way. `revu doctor` reports the detected mode and
verifies `claude` is installed and logged in.

## CI

Not part of v1. M4 (a GitHub Action with report verification and SARIF check
runs) is fully specced in the design doc but deliberately deferred — v1 is
scoped to the local loop (`revu` + the lefthook pre-push hook) so the
committee is proven on real diffs first.

## Releasing

See [Bumping the version](#bumping-the-version).

## License

[MIT](LICENSE) © 2026 Sergio Lopez.

Free to use, copy, modify, and distribute — commercially or otherwise. The one
condition: the copyright notice and the MIT permission notice must be kept in
all copies and substantial portions, including modified versions and
derivative works.
