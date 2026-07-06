---
name: jira-release
description: Use when the user wants release notes or a changelog drafted from a git range — "draft release notes", "what's in this release", "changelog for v1.2 to v1.3" — especially when commits or branches reference Jira issue keys.
---

# jira-release — release notes from git + Jira

Drafts release notes by comparing a git range and enriching it with the Jira
issues the commits reference.

## Flow
1. **Collect commits**: `git log --oneline <from>..<to>` (ask for the range if
   ambiguous; default `<last-tag>..HEAD` via `git describe --tags --abbrev=0`).
2. **Extract Jira keys** from commit subjects/bodies and branch names
   (pattern `[A-Z][A-Z0-9]+-\d+`). For each unique key, `jira_issue` → real
   title, type, and status. Issues beat commit messages as the human-readable
   source of truth.
3. **Group** into Features, Fixes, Breaking changes (breaking = commit says so,
   issue is labeled `breaking`, or the diff removes/renames public API).
   Commits with no Jira key still get a line — never silently drop work.
4. **Write** the notes: audience is users, not developers — lead each entry
   with the benefit, keep issue keys as trailing links
   (`https://<site>.atlassian.net/browse/<KEY>`). Match the format of previous
   releases if a CHANGELOG.md exists (point at a reference).
5. **Offer follow-ups** (each needs explicit confirmation): comment the release
   version on each issue (`jira_comment`), set `fixVersion` via
   `jira_update_issue`, or transition shipped issues to Done.

## Verify your own work
Cross-check: every Jira key in the range appears in the notes exactly once,
and the issue's status is Done/shipped — flag keys that are still open, they
may not belong in this release.
