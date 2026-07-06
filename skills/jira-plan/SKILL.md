---
name: jira-plan
description: Use when the user wants meeting notes, a spec, a discussion, or a feature request turned into Jira tickets — "turn these notes into tickets", "break this down into jira tasks", "create tickets from this doc" — or wants a change scoped/estimated before it goes on the roadmap.
---

# jira-plan — notes/spec → scoped Jira tickets

Turns unstructured input (meeting notes, spec, conversation) into well-formed
Jira tickets, optionally scoped against the actual codebase first.

## Flow
1. **Read the input** (file, pasted text, or the conversation itself). Extract
   discrete action items — one ticket each, no umbrella tickets.
2. **Scope before filing** (when a repo is available and the item touches
   code): identify which files each change would touch and how risky it is.
   Put the estimate in the ticket (`Scope: ~N files — <areas>; Risk: low/med/high`).
3. **Draft first, then file.** Show the user the ticket list (summary, type,
   acceptance criteria) BEFORE creating anything. Batch-create only after they
   confirm — creating tickets is outward-facing.
4. **File** each with `jira_create_issue`: crisp summary (imperative, ≤80
   chars), description containing **Context** (1-2 lines), **Acceptance
   criteria** (checklist, each independently verifiable), and the scope
   estimate. Project comes from the folder mapping; pass `account:`/`project:`
   when the user names another site.
5. **Report** the created keys as a list with URLs.

## Quality bar for acceptance criteria
Each criterion must be observable ("returns 404 for deleted items"), not
activity ("handle errors"). If the source input is vague, ask — don't invent
requirements.
