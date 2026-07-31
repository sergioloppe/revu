/**
 * `revu init --claude` payload (design §5.2): three Claude Code slash-command
 * prompts written to `.claude/commands/`, plus `revu init`'s `lefthook.yml`
 * (design §7 — front door is the slash command, the pre-push hook is the backstop,
 * with a deliberate, visible escape hatch).
 *
 * These markdown files are prompts for a Claude Code session, never executed by
 * revu itself — keep them out of `templates.ts` (the `.review/` catalog) so that
 * file doesn't grow to cover two unrelated audiences.
 */

export const CLAUDE_COMMAND_TEMPLATES: Record<string, string> = {
  'revu.md': `---
description: Run revu's tier-1 blocking review and offer to fix findings in-session.
---

Run the tier-1 (blocking) committee against the current changes and act on
what it reports.

1. Run \`revu --tier 1 --format pretty\` in the repo root (use \`--staged\`
   instead if the user says they want staged changes reviewed, not the full
   working diff).
2. Exit 3 means a config or tool problem — tell the user to run
   \`revu doctor\` and stop.
3. Exit 4 means a tier-0 check (lint/typecheck/...) failed before any
   reviewer ran — show the check output revu printed; there are no findings
   to act on yet, so stop there.
4. Otherwise read \`.review-report.json\` and render every finding grouped
   by reviewer: file:line, rule id, severity, message, and the suggested fix
   if present. Summarize the overall pass/fail status and, if failing, the
   blocking reason.
5. Ask which findings (if any) the user wants fixed now. For each one they
   pick, make the edit yourself with your normal edit tools — the reviewer
   that found it never has write access, so applying the fix is entirely
   your job, done under the user's own permissions in this session.
6. After applying fixes, suggest re-running \`/revu\` to confirm they're
   resolved. Don't re-run automatically — let the user decide.
7. If a finding looks wrong (false positive, out of scope, not worth it),
   suggest \`/revu-triage\` to dismiss it with a reason instead of just
   letting it sit unaddressed.
`,

  'revu-rule.md': `---
description: Interview the user about a coding convention and draft a new revu rule.
argument-hint: [short description of the convention]
---

Draft a new rule for revu's catalog from a convention the user describes.

1. If $ARGUMENTS gives a starting description, use it; otherwise ask what
   convention or pattern they want enforced.
2. Interview briefly to pin down: which domain it belongs to (architecture,
   security, testing, company-standards, performance, maintainability,
   documentation), severity, and which files it applies to (\`applies_to\`
   glob(s), optional \`exceptions\`). Rules always start
   \`status: proposed\`, \`blocking: false\` — they earn blocking status
   with real usage data, not on day one.
3. Check \`.review/rules/<domain>/**\` and the global catalog (\`revu config
   show --effective\`) for an id collision or an existing rule that already
   covers this ground. If one is close, propose editing it instead of
   creating a duplicate.
4. Pick a rule id following the existing \`<DOMAIN-PREFIX>-<NNN>\`
   convention (e.g. SEC-003) — read the existing files in that domain to
   find the next free number.
5. Write the rule file with frontmatter (id, title, domain, severity,
   blocking: false, status: proposed, applies_to, optional exceptions) and a
   body with a short rationale plus \`## Violating\`, \`## Compliant\`, and
   \`## How to fix\` sections, matching the style of the existing rules.
6. Run \`revu rules lint\` and fix anything it flags (frontmatter errors,
   duplicate ids) before telling the user it's done.
`,

  'revu-triage.md': `---
description: Walk the findings in the last revu report and draft dismissals for the ones that shouldn't block.
---

Triage the findings from the most recent revu run.

1. Read \`.review-report.json\` in the repo root. If it doesn't exist, tell
   the user to run \`revu\` first and stop.
2. List every finding that isn't already in \`suppressed\` (those are
   already handled by the baseline or an existing dismissal): reviewer,
   rule id, file:line, severity, message.
3. Walk them one at a time with the user. For each, ask: fix now, dismiss,
   or leave open.
   - "fix now" -> hand off to the same fix flow as \`/revu\`.
   - "dismiss" -> ask for a short reason, then run
     \`revu --dismiss <finding-id> --reason "<reason>"\`, which appends to
     \`.review/dismissals.yaml\` with \`approved_by\` from git config and a
     180-day expiry. Never hand-edit dismissals.yaml directly — the CLI
     refuses to dismiss an id that isn't actually in the last report.
   - "leave open" -> skip it, no action.
4. When done, summarize what was dismissed, what's still open, and remind
   the user dismissals expire after 180 days (\`revu doctor\` flags ones
   expiring within 30 days).
`,
};

export const LEFTHOOK_YML = `# Written by \`revu init\`. Blocks \`git push\` on tier-1 (blocking) findings —
# the slash commands are the front door, this is the backstop (design §7).
pre-push:
  commands:
    revu:
      run: revu --tier 1 --format pretty
      fail_text: |
        revu found blocking issues (tier 1). Fix them, or if this push has
        to go through anyway, bypass this check deliberately:

          git push --no-verify

        Bypassing is visible, not silent: the finding is still there next
        time revu runs against this branch.
`;
