---
name: jira-sync
description: Use when the user wants a repo's roadmap/planning state pushed to Jira or Confluence — "sync jira", "update jira", "push phases to jira" — in a repo with a .planning/ROADMAP.md (GSD convention).
---

# jira-sync — publish roadmap state to Jira

One Jira Task per `.planning/ROADMAP.md` phase (idempotent — safe to re-run;
`.planning/.jira-sync-cache.json` prevents duplicates from Jira search-index
lag) and, if a space is mapped, one living Confluence status page per
repo+milestone.

```bash
node <plugin>/scripts/roadmap-sync.mjs <repo-dir> [--dry]
```

- `<repo-dir>` = path (absolute or relative); works from any cwd.
- Run `--dry` first when unsure; it parses and prints without touching the API.
  Expected shape: a header (`repo → account (site) project=KEY … phases=N`)
  then one `[dry] upsert` line per phase.
- Exit 2: **read stderr, two causes** — "no mapping" → run the jira-init
  skill; "missing _SITE/_EMAIL/_TOKEN" → run the jira-setup skill.
- Requires `.planning/ROADMAP.md` with `## Phase N:` headings.

After sync, report created/existing issue keys with the site URL
(`https://<site>.atlassian.net/browse/<KEY>`).
