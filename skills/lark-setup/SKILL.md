---
name: lark-setup
description: Use when the user wants Lark Suite / Feishu connected for tasks or docs — "set up lark", "connect feishu", "add larksuite" — or lark MCP tools are missing/failing with auth errors.
---

# lark-setup — connect Lark Suite / Feishu

Runs on the **official** `@larksuiteoapi/lark-mcp` server; this plugin supplies
config + registration + workflow skills on top.

## Steps
1. **App creation (user step — needs their browser login):** create a "Custom
   App" at https://open.larksuite.com (international) or https://open.feishu.cn
   (China), add permissions — tasks: `task:task`; docs: `docx:document`,
   `wiki:wiki`, `drive:drive` (read) — publish the app, and copy App ID +
   App Secret from *Credentials & Basic Info*.
2. **Config:** `cp <plugin>/config.example/lark.env.example
   ~/.config/jira-multi/lark.env`, fill in ID/secret/domain. The secret is a
   credential — have the user paste it into the file themselves, and
   `chmod 600` it. `LARK_TOKEN_MODE=tenant` (app identity, simplest) or `user`
   (acts as the user; one-time OAuth login, printed by the script).
3. **Register:** `<plugin>/scripts/lark-add.sh` → registers MCP server `lark`
   (user scope) with `preset.task.default,preset.doc.default`. Session restart
   required before the tools appear.
4. **Verify:** call a cheap lark tool (e.g. wiki/docx search) and confirm no
   auth error.

## Troubleshooting
- Wrong-domain symptoms (app not found / invalid app_id): Feishu app on
  larksuite domain or vice versa — fix `LARK_DOMAIN`.
- Permission errors name the missing scope — add it in the app console, then
  re-publish the app version.
- Beta caveats (upstream): no file upload/download; docs are import/read, not
  direct in-place editing.
