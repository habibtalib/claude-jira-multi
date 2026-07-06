---
name: jira-work
description: Use when the user wants to pick up their Jira work queue — "what's new on my jira", "any tasks assigned to me", "what's in the backlog to start", "work the next ticket", "start on my jira tasks" — covering brief → start → implement → move to review → hand back to the reporter.
---

# jira-work — queue brief → work → hand back for review

Uses the `jira_*` tools; the folder resolves the site (pass `account:` per
call, or sweep every account from `jira_accounts` when asked "across all").

## 1. Brief the queue
Run both searches (`max` ~15 each):
- **Assigned to me**: `assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, created DESC`
- **Backlog, ready to start**: `assignee IS EMPTY AND statusCategory = "To Do" ORDER BY priority DESC, updated DESC`

Present one numbered brief: `KEY · type · priority · summary · reporter ·
status`, newly-assigned first. Recommend the top item with one line of why.
Ask which to start — unless the user already named a ticket or said "just
start", then take the top item.

## 2. Start the ticket
1. `jira_issue` → read description and comments fully before touching code.
2. `jira_assign` with `"me"` if unassigned.
3. `jira_transition` — list first, execute the transition whose name/target
   matches /progress/i.
4. Branch `KEY-short-slug` so commits/PRs auto-link.

## 3. Work
Implement as a normal task. Verify your own work: run the tests and the
ticket's repro (if any) before calling it done.

## 4. Hand back for review — automatic, all three steps
1. `jira_comment` — what changed: commits/branch/PR link, test evidence,
   anything the reviewer needs to know.
2. `jira_transition` — list, then execute the first transition matching
   /review/i. **No review column** (simple To Do/In Progress/Done board):
   leave the status as-is, and say so — never silently mark Done; only move
   to Done if the user tells you to.
3. `jira_assign` with `"reporter"` — hands the issue back to whoever filed it.

Report: issue URL, new status, new assignee. Then offer the next item from
the brief.
