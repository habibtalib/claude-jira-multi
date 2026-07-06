---
name: jira-adhoc
description: Use when the user reports a bug or wants an ad-hoc Jira issue filed ("file this bug", "create a jira ticket", "log this issue"), or wants to work on an existing Jira issue ("work on PROJ-123", "fix that jira bug").
---

# jira-adhoc — file or work Jira issues/bugs

Use the `jira_*` MCP tools — they auto-resolve the current folder to its Jira
site (pass `account:` to target another site; `jira_accounts` shows the
resolution). If the MCP tools aren't loaded (e.g. in a subagent), fall back to
`<plugin>/scripts/jira.sh <account> GET|POST <path> [json]`.

## File a bug/issue
1. `jira_create_issue` with `summary`, `type` (Bug/Task), plain-text
   `description` (repro steps, expected vs actual, file:line refs). Project
   defaults from the folder mapping; if the project lacks the type
   (team-managed kanban has no Bug), the server falls back to an available
   type + a label automatically — mention the returned `note`.
2. If it errors with "no project key", run the jira-init skill first.
3. Report the returned issue URL.

## Work an existing issue
1. `jira_issue` with the key → read summary/description/comments.
2. Do the work as a normal task.
3. On completion: `jira_comment` with what changed (commits/branch), then
   `jira_transition` (list first, then move to In Progress/Done as fits).

## Triage
`jira_search` with JQL, e.g. `assignee = currentUser() AND status != Done
ORDER BY priority DESC, updated DESC` — add `account:` to sweep other sites.
