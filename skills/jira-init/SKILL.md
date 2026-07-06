---
name: jira-init
description: Use when a repo/folder needs Jira linkage — new project kickoff, "link jira", "init jira", "connect this repo to jira" — or when issue creation fails with "no project key" / sync fails with "no mapping".
---

# jira-init — link a repo to its Jira site

Ensures a Jira project exists for the repo and writes the folder→account
mapping that jira-multi's auto-resolution relies on.

**No accounts configured yet?** (script says "no Atlassian accounts
configured", or `jira_accounts` shows none) — run the **jira-setup** skill
first: it creates `accounts.env` and walks the user through token creation.
The token paste is always a user step (Atlassian gates the token page behind
an emailed passcode); Claude prepares everything else.

```bash
<plugin>/scripts/jira-init.sh <repo-dir> [account[:PROJECTKEY[:SPACEKEY]]] [--dry]
```

- `<repo-dir>` = path (absolute or relative); works from any cwd.
- Account defaults to `default=` in `~/.config/jira-multi/map.env`, else the
  only configured account; otherwise pass one explicitly.
- Project key derives from the repo name unless given. Existing mappings are
  never overwritten (idempotent). `--dry` previews without touching the API.
- Creating a missing project needs project-create permission on that site; if
  it fails, ask the user for an existing project key instead:
  `jira-init.sh <repo> <account>:<EXISTINGKEY>`.
- Add `:SPACEKEY` only if a Confluence status page is wanted (roadmap-sync).

After init, verify with `jira_accounts` — the folder should resolve to the new
account/project.
