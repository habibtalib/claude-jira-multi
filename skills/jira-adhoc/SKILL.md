---
name: jira-adhoc
description: Use when the user reports a bug or wants an ad-hoc Jira issue filed ("file this bug", "create a jira ticket", "log this issue"), wants to work on an existing Jira issue ("work on PROJ-123", "fix that jira bug"), or wants a cross-site view of their assigned work ("what's on my plate", standup summary).
---

# jira-adhoc — file or work Jira issues/bugs

Use the `jira_*` MCP tools — they auto-resolve the current folder to its Jira
site (pass `account:` to target another site; `jira_accounts` shows the
resolution). If the MCP tools aren't loaded (e.g. in a subagent), fall back to
`<plugin>/scripts/jira.sh <account> GET|POST <path> [json]`.

## File a bug/issue
1. **Capture the artifact, not a paraphrase**: put the actual stack trace,
   error log excerpt, or failing command output in the description, plus repro
   steps, expected vs actual, and `file:line` refs when known.
2. `jira_create_issue` with `summary` (imperative, ≤80 chars), `type`
   (Bug/Task), plain-text `description`. Project defaults from the folder
   mapping; if the project lacks the type (team-managed kanban has no Bug),
   the server falls back to an available type + a label — mention the
   returned `note`.
3. "no project key" error → run the jira-init skill first.
4. Report the returned issue URL.

## Work an existing issue end-to-end
1. `jira_issue` with the key → read summary/description/comments before
   touching code.
2. Branch with the key in the name (`PROJ-123-short-slug`) so commits and PRs
   auto-link in Jira.
3. Implement, then **verify your own work**: run the tests (and the repro from
   the ticket, if any) before calling it done.
4. On completion: `jira_comment` with what changed — commits, branch, PR link,
   test evidence. Then `jira_transition` (list first, then move to In
   Progress/Done as fits). If the user wants a PR, reference the issue key in
   the PR title.

## Triage / standup
`jira_search` with JQL, e.g. `assignee = currentUser() AND status != Done
ORDER BY priority DESC, updated DESC`. For a cross-site sweep, run it once per
account from `jira_accounts` and merge into one list grouped by site — this is
the one thing single-site Jira integrations can't do.
