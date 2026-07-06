# Linking Lark Suite / Feishu — step-by-step tutorial

End-to-end walkthrough for connecting a Lark (or Feishu) workspace to Claude
Code through this plugin, exactly as executed on a real workspace. Takes about
10 minutes. Result: `lark` MCP tools for **task management** and
**documentation**, with zero re-authentication afterwards.

## 0. What you'll end up with

- A **custom app** in your Lark workspace (you own it, deletable anytime)
- Its App ID + Secret in `~/.config/jira-multi/lark.env` (local, chmod 600)
- MCP server `lark` registered user-scope in Claude Code, exposing
  `preset.task.default` + `preset.doc.default` from the official
  [`lark-openapi-mcp`](https://github.com/larksuite/lark-openapi-mcp)

## 1. Create the app (browser, ~2 min)

1. Go to the developer console **for your domain** — this matters later:
   - International Lark: https://open.larksuite.com/app
   - Feishu (China): https://open.feishu.cn/app
2. Two working paths:
   - **Create Custom App** — plain app, you add everything yourself.
   - **Create Agent-Ready App** — one-click app with bot + agent settings
     pre-configured and auto-published as v1.0.0. Faster start, but note: it
     does **NOT** include task/docs scopes — you add those next either way.
3. Name it something recognizable (e.g. `claude-code`).
4. From **Credentials & Basic Info**, copy the **App ID** (`cli_...`) and
   **App Secret**.

## 2. Add the scopes (browser, ~3 min)

Permissions & Scopes → **Add permission scopes to app**. The search box accepts
a comma-separated list — paste this and select all results:

```
task:task:write,docx:document,wiki:wiki,wiki:wiki:readonly,drive:drive,search:docs:read
```

None of these require org-admin approval ("Approval required: No").

**Task data range:** the task scope demands a "Range of accessible data".
Click **Configure** → choose **All** (or filter by condition for tighter
control) → **Save**. The status flips to "To be published" — that means saved,
pending release.

## 3. Publish the version (browser, ~2 min)

Scope changes only take effect after a version release:

1. Click **Create Version** (banner at the top).
2. Version number and update notes are prefilled; fill **Reason for request**
   (one line is fine) → **Save** → **Submit for release**.
3. In a workspace where you're the admin this self-approves — the version page
   shows **Released / Approved** immediately.

## 4. Configure + register (terminal, ~2 min)

```bash
cp config.example/lark.env.example ~/.config/jira-multi/lark.env
# edit: LARK_APP_ID, LARK_APP_SECRET, and LARK_DOMAIN
#   https://open.larksuite.com  for international Lark
#   https://open.feishu.cn      for Feishu
chmod 600 ~/.config/jira-multi/lark.env

# sanity-check the credentials before registering (code 0 = good):
curl -s -X POST "$LARK_DOMAIN/open-apis/auth/v3/tenant_access_token/internal" \
  -H 'Content-Type: application/json' \
  -d '{"app_id":"<id>","app_secret":"<secret>"}'

scripts/lark-add.sh    # registers MCP server 'lark' at user scope
```

Restart your Claude Code session. Verify by asking Claude to create a Lark
task — it should return a task GUID created by your app.

## 5. Tenant vs user token mode

| | tenant (default) | user (`LARK_TOKEN_MODE=user`) |
|---|---|---|
| Acts as | the app | you |
| Task create/update/complete | ✅ | ✅ |
| Doc read by ID (`rawContent`) | ✅ (docs shared with the app) | ✅ (your docs) |
| **Doc search** (`docx.builtin.search`) | ❌ "User access token is not configured" | ✅ |
| **Markdown import** (`docx.builtin.import`) | ❌ | ✅ |
| Extra setup | none | redirect URL in app Security Settings + one-time `lark-mcp login` OAuth |

Start with tenant mode; switch to user mode when you need doc search/import:
set `LARK_TOKEN_MODE=user` in `lark.env`, add `http://localhost:3000/callback`
as a redirect URL in the app's **Security Settings**, run the login command
`lark-add.sh` prints, approve the consent screen, re-run `lark-add.sh`.

## Troubleshooting (real errors, real fixes)

- **`Access denied ... [task:task:write]` (code 99991672)** — scope missing or
  version not published. The error's `helps[].url` deep-links to the exact
  scope-add page for your app. Add → publish a version → retry.
- **`User access token is not configured`** — you called a user-context tool
  (doc search/import) in tenant mode. See §5.
- **Invalid app_id / app not found** — domain mismatch: Feishu app used with
  the larksuite domain or vice versa. Fix `LARK_DOMAIN`.
- **Scope added but API still denies** — check the app page banner: "changes
  take effect after the current version is published". Publishing is the step
  people skip.
- **Task data range red flag on release form** — the range wasn't saved; open
  Configure, pick All, Save (status must read "To be published").

## Security notes

- The App Secret lives in `lark.env` (600) and in `~/.claude.json` (the
  registered server's args) — both local files. Rotate the secret from the
  app console if either machine is compromised.
- The app only holds the scopes you granted; the console shows every API it
  can call (Permissions & Scopes → Related APIs/Events).
- Uninstall = delete the app in the console + `claude mcp remove lark -s user`.
