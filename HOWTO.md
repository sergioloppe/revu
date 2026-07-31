# revu — HOWTO

A step-by-step guide to installing `revu`, setting it up in a repo, running your
first review, and living with it day to day. For the reference-style overview
(every command, flag, and exit code) see [`README.md`](README.md). For writing
your own rules see [`docs/authoring-rules.md`](docs/authoring-rules.md); for the
full `config.yaml` see [`docs/configuration.md`](docs/configuration.md).

---

## 0. What revu is (30 seconds)

`revu` runs a committee of specialist AI reviewers against your **branch diff**,
before you open a PR. Each reviewer is narrow — it only looks for violations of
the rules in its catalog — and returns machine-readable findings. Plain
TypeScript, not a model, then turns those findings into one pass/fail decision.

- The **rules you write** are the product. The reviewers are only as good as the
  catalog in `.review/`.
- Reviewers are **read-only**: they can read your code, never write or commit.
- It runs on your **Claude Code login** (Max subscription = no per-review bill).

---

## 1. Install

Requires **Node.js ≥ 20** and the **`claude` CLI logged in** (`claude` on your
PATH; check with `claude --version`).

```bash
git clone https://github.com/sergioloppe/revu.git
cd revu
npm install
npm run build      # compiles TypeScript → dist/
npm link           # puts the `revu` command on your PATH
```

`npm link` symlinks the global `revu` to this checkout. When you pull new
changes, re-run `npm run build` and the global command updates in place. (Once
the package is published you'll be able to `npm install -g revu` instead.)

Confirm it works:

```bash
revu --version
revu doctor         # checks: claude present + logged in, auth mode, config health
```

`revu doctor` run outside a configured repo will still report your auth mode and
whether `claude` is reachable — that's the fastest way to confirm the install.

---

## 2. Set up a repo

From the root of a git repository you want to review:

```bash
revu init
```

This scaffolds a `.review/` directory:

```
.review/
├── config.yaml            # the one settings file
├── reviewers/             # 7 reviewer personas (architecture, security, …)
├── rules/                 # starter rules per domain, all advisory
│   ├── security/SEC-001.md
│   └── …
├── schema/report.schema.json
└── .gitignore             # ignores cache/
lefthook.yml               # pre-push hook (written at repo root if absent)
```

Commit it — `.review/` is meant to be version-controlled and reviewed like code:

```bash
git add .review lefthook.yml
git commit -m "add revu"
```

Optionally install the Claude Code slash commands (`/revu`, `/revu-rule`,
`/revu-triage`) into this repo's `.claude/`:

```bash
revu init --claude
```

### The starter catalog blocks nothing — on purpose

Every scaffolded rule ships `status: proposed` and `blocking: false`. A fresh
`revu` run will *print* findings but **never fail**. This is deliberate: rules
earn the right to block by proving themselves on real diffs first (see §6). To
make a rule actually gate, you edit it — that's the next step.

---

## 3. Run your first review

Make a change on a branch, then:

```bash
git checkout -b my-feature
# … edit code, commit …

revu                 # reviews the branch diff vs merge-base with origin/main
```

Other ways to scope what gets reviewed:

```bash
revu --staged                 # only what's staged (git add)
revu --working                # every uncommitted change to a tracked file
revu --range main...HEAD      # an explicit git range
revu --files src/a.ts         # only these paths
revu --only security          # just one reviewer (fast, cheap)
revu --tier 1                 # blocking committee only, skip advisory tier 2
```

You'll get a colored summary in the terminal, and a full JSON envelope is written
to `.review-report.json` every run. For the machine-readable form on stdout:

```bash
revu --format json | jq .status
```

### Reading the result

```
revu FAIL — security reported 1 blocking issue(s) at or above high

security: FAIL (confidence 1)
  Critical security vulnerability: eval on user input.
  src/util.ts:2 [SEC-001] critical — Dynamic code execution on user input
    fix: Parse the input into a restricted AST or use a sandboxed interpreter.

14.3s | cost $0.03 (subscription) | layers: builtin+repo
```

- **Top line** = the overall verdict and why.
- Each reviewer prints its status, then one line per finding:
  `file:line [RULE-ID] severity — message`, with a suggested fix.
- **Footer** = wall-clock, cost (and whether it rode your subscription or an API
  key), and which config layers contributed.

The **exit code** is what a hook or script keys on:

| Code | Meaning |
|---|---|
| 0 | Pass (or only advisory/tier-2 warnings) |
| 1 | A blocking reviewer found a blocking issue |
| 2 | A reviewer needs a human (bad output after retry, or timeout) |
| 3 | Tool error: bad config, `claude` not logged in, or the no-write assertion tripped |
| 4 | A tier-0 check failed — no reviewers ran, nothing spent |

---

## 4. Turn a rule into a gate

Open a starter rule, e.g. `.review/rules/security/SEC-001.md`, and change its
frontmatter:

```diff
 ---
 id: SEC-001
 title: No dynamic code execution on user input
 domain: security
 severity: critical
-blocking: false
-status: proposed
+blocking: true
+status: active
 applies_to:
   - "**/*.ts"
 ---
```

Now a diff that violates SEC-001 will fail `revu` with exit 1 (as long as the
severity is at or above `aggregation.fail_on_severity`, which defaults to
`high`). Commit the change like any other.

Writing your *own* rules is the real work — the full guide is
[`docs/authoring-rules.md`](docs/authoring-rules.md). The short version: one
markdown file per rule, frontmatter is the machine contract, the body is the
prompt the reviewer reads.

---

## 5. Suppress existing findings (baseline) and exceptions (dismissals)

When you first enable rules on an existing codebase, you don't want a wall of
findings in legacy code. Record a **baseline**:

```bash
revu --baseline      # runs the review, writes every current finding to
                     # .review/baseline.json, and exits 0
git add .review/baseline.json && git commit -m "revu baseline"
```

From then on, baselined findings are suppressed — only *new* violations fail the
run. Because findings are keyed by a stable content hash, touching the offending
code un-suppresses it: legacy code is grandfathered until someone edits it.

For a specific, justified exception, use a **dismissal**:

```bash
revu                                        # produces .review-report.json
revu --dismiss a3f9c1e2 --reason "Predates the service layer; tracked in ARCH-441"
```

This appends to `.review/dismissals.yaml` with your `git` user as approver and a
180-day expiry. Commit it — dismissals are reviewed like code, and they
**reactivate automatically when they expire**, so exceptions don't silently
become permanent. Suppressed findings still appear in the JSON envelope's
`suppressed` array, so nothing vanishes without a trace.

---

## 6. Promote rules with evidence, not vibes

The intended workflow for each rule:

1. Write it as `status: proposed`, `blocking: false`. It prints and is counted,
   but blocks nothing.
2. Run it against real diffs for a while. Watch what it catches and what it
   false-positives on (the JSON envelope records every finding).
3. Once you trust it, flip it to `status: active`, `blocking: true`.

The design's own advice: run a single reviewer against ~50 real diffs and read
**every** finding before you let it gate. A rule that fires constantly but gets
dismissed every time is a broken rule — delete it, don't tune it forever.

---

## 7. Add deterministic pre-checks (tier 0)

Before spending a single token on reviewers, `revu` can run your existing
lint/typecheck/test/build as **tier-0** checks. The first one that fails aborts
the whole run with exit 4 — no reviewer runs, nothing is spent. Uncomment and
edit the `tiers` block in `.review/config.yaml`:

```yaml
tiers:
  "0":
    checks:
      - id: typecheck
        command: npx tsc --noEmit
        timeout_seconds: 120
      - id: lint
        command: npx eslint .
```

Run only tier 0 with `revu --tier 0`.

> **Security note.** Tier-0 `command` entries are **arbitrary shell commands run
> with your privileges** — they are *not* covered by the reviewer no-write
> guarantee. Treat `.review/config.yaml` as trusted code, and never run `revu`
> against a repo/config you don't trust. See the README's "Tier-0 trust
> boundary".

---

## 8. Wire it into your workflow

**Pre-push hook.** `revu init` writes a `lefthook.yml` that runs
`revu --tier 1 --format pretty` before every push. Install lefthook and its
hooks:

```bash
npm install --save-dev lefthook
npx lefthook install
```

Now a push that introduces a blocking violation is stopped, with the escape
hatch advertised in the message:

```
Review failed. Fix, or override with: git push --no-verify
```

The escape hatch is intentional — a gate people can't bypass gets bypassed
structurally instead. Track how often `--no-verify` is used rather than trying
to prevent it.

**Mid-work, in a Claude session.** If you ran `revu init --claude`, use `/revu`
inside Claude Code to review and fix findings in the same session where you can
act on them. `/revu-rule` helps you author new rules; `/revu-triage` walks
findings and drafts dismissals.

---

## 9. Speed and cost

- **Caching.** Identical (reviewer + model + rules + full prompt + diff) reviews
  are memoized under `.review/cache/`. A cache hit skips the subprocess entirely.
  Force a fresh run with `--no-cache`.
- **Scope down.** `--only security` or `--tier 1` runs fewer reviewers.
  `--files` limits the diff.
- **Model per reviewer.** In `config.yaml`, cheap reviewers use
  `claude-haiku-4-5`; reserve the strong model for high-stakes ones like
  security. See [`docs/configuration.md`](docs/configuration.md).
- **Cost is reported, not always billed.** On a Max subscription, review spend
  rides your plan; the reported USD is an equivalent, and `auth_mode:
  subscription` in the envelope tells you so. Set `ANTHROPIC_API_KEY` (e.g. in
  CI) and `revu` switches to `api_key` mode, where `auth.max_cost_usd_per_run`
  becomes a hard stop.

---

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `revu: cannot run "claude --version"` (exit 3) | `claude` isn't on PATH or isn't logged in. Run `claude` once to log in; re-check with `revu doctor`. |
| `nothing to review — … is empty` (exit 3) | The selected diff had no content. Bare `revu` reviews **committed** work only, so a branch whose changes are still staged or unstaged produces an empty diff. The error lists what the working tree holds and the flag for it — usually `--staged` or `--working`. |
| The run goes quiet for minutes | It hasn't hung: reviewers take 30–180s each. Progress streams to stderr, including a "still running" line every 20s naming what's in flight. `-q` turns it off; `2>/dev/null` also hides it. |
| Everything prints but nothing ever fails | The starter rules are all `status: proposed` / `blocking: false`. Activate one (§4). |
| `SECURITY: reviewer "…" mutated repository state` (exit 3) | A reviewer wrote to the working tree — the no-write assertion aborted the run. This should never happen with the read-only toolset; report it. |
| Exit 4, no reviewers ran | A tier-0 check failed. revu prints the check's command, how it exited, and its output above the summary — run that command yourself to reproduce it. |
| A tier-0 check fails with no output | The command swallowed it. `test -z "$(gofmt -l .)"` captures the file list into the substitution and exits 1 silently. Rewrite it to print before failing: `out=$(gofmt -l .); [ -z "$out" ] \|\| { echo "$out"; exit 1; }`. |
| Tier 0 fails on code you didn't touch | Tier-0 commands run repo-wide (`go vet ./...`, `gofmt -l .`), not over your diff, so pre-existing debt anywhere blocks the review. Fix it, scope the command to the paths you own, or run `revu --skip-tier 0` to review anyway. |
| `--tier must be 0, 1, or 2` | `--tier` only accepts those values. |
| A reviewer returns `NEEDS_HUMAN_REVIEW` (exit 2) | The model's output failed schema validation twice, or it timed out. The raw output is in the envelope's `debug` field for that reviewer. |
| Findings you disagree with keep firing | Baseline them (§5) if legacy, dismiss with a reason if a genuine exception, or fix the rule if it's just noisy. |
| Config error mentioning `allowed_tools` | The read-only toolset is not configurable by design. Remove any `allowed_tools` key from `config.yaml`. |

Run `revu doctor` first for any "is my setup OK?" question — it checks auth,
config parsing, reviewer/persona wiring, duplicate rule ids, and expiring
dismissals in one shot.
