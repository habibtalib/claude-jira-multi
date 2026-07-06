---
name: jira-setup
description: Use when jira-multi isn't configured yet, a new Atlassian account/site needs adding, tokens expired, or jira tools return "not configured" / "has no API token" / 401 errors — "set up jira", "add jira account", "configure jira-multi".
---

# jira-setup — configure accounts and tokens

Config lives in `~/.config/jira-multi/` (override: `JIRA_MULTI_CONFIG`).

1. **First time:** `mkdir -p ~/.config/jira-multi` and copy both files from the
   plugin's `config.example/` (drop the `.example` suffix). Edit `accounts.env`:
   one `<NAME>_SITE/_EMAIL` block per Atlassian login.
2. **Tokens:** the user must create them at
   https://id.atlassian.com/manage-profile/security/api-tokens while logged in
   as that email (incognito window — SSO reuses the wrong account silently).
   Never enter the user's Atlassian password or one-time passcodes yourself.
   Store with `<plugin>/scripts/jira-token-add.sh <account>` (hidden input,
   auto-fills every account sharing that email, verifies via `/myself`).
3. **Verify:** `jira_accounts` (token status + folder resolution), then
   `jira_myself` per account.
4. **Folder mapping:** add `<folder>=<account>[:PROJECT[:SPACE]]` lines and a
   `default=<account>` to `map.env` — or use the jira-init skill per repo.

## Troubleshooting
- 401 on every call: token invalid OR that email has no access to that site —
  Atlassian returns 401 for both. Confirm which site the email actually owns.
- Token expired (max 1 year): re-run `jira-token-add.sh <account>`.
