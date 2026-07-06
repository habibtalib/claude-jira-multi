---
name: lark-tasks
description: Use when the user wants task management in Lark Suite / Feishu — "create a lark task", "add this to my lark tasks", "assign a task in lark", "remind me in lark" — or wants Jira work mirrored into Lark tasks.
---

# lark-tasks — task management in Lark Suite

Uses the `lark` MCP server's `task.v2.*` tools (preset.task.default: create,
patch, addMembers, addReminders). Not connected → run the lark-setup skill.

## Create a task
`task.v2.task.create` with a crisp summary (imperative, ≤80 chars), a
description carrying the real context (artifact excerpts, links, `file:line`
refs), and `due` when the user gives a deadline. Then:
- assignees → `task.v2.task.addMembers` (role: assignee)
- reminders → `task.v2.task.addReminders` (relative to due time)
Report the task GUID/URL from the response.

## Update / complete
`task.v2.task.patch` — change summary/description/due, or set `completed_at`
to mark done. Patch only the fields being changed (`update_fields`).

## Mirror a Jira issue into Lark
When the user tracks execution in Jira but coordinates people in Lark:
1. `jira_issue` (jira-multi) → summary, key, URL.
2. Create the Lark task titled `[KEY] summary`, description linking the Jira
   URL. One direction only (Jira = source of truth) — say so in the task
   description so nobody edits the mirror expecting sync.

## Caveats
- The task preset has no list/query tool — track created GUIDs in your reply;
  for browsing, the user has the Lark Tasks app.
- Tenant mode creates tasks as the app; user mode (lark-setup) creates them as
  the user — pick per the user's expectation of "who created this".
