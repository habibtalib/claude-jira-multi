# jira-multi — multi-site Jira/Confluence for Claude Code

One MCP server for **all** your Atlassian sites. API-token auth (no OAuth, no
browser dance, nothing to re-authenticate), and the right site is picked
**automatically from the folder you're working in**.

## Why

The official Atlassian MCP server (`mcp.atlassian.com`) authenticates one OAuth
account per server. If your projects span several Jira sites under different
logins — work, personal, clients — you end up with N servers, N `/mcp`
authentication rounds, and periodic re-auth on each. And OAuth can't run
headless (cron, CI, remote agents) at all.

`jira-multi` replaces that with one zero-dependency stdio server:

- **Every site, one server** — accounts defined in a local env file, Basic auth
  with [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
- **Folder → site auto-resolution** — a mapping file links directory names to
  accounts; working in `~/code/client-app` talks to the client's Jira, no
  switching. Every tool also takes an explicit `account` argument, so you can
  query any site from anywhere.
- **Zero re-authentication** — tokens last up to a year and work headless.
- **Zero dependencies** — plain Node ≥ 18, no npm install.

## Install

### As a Claude Code plugin (recommended — MCP server + skills)

```
/plugin marketplace add habibtalib/claude-jira-multi
/plugin install jira-multi@claude-jira-multi
```

### MCP server only (any MCP client)

```bash
git clone https://github.com/habibtalib/claude-jira-multi.git
claude mcp add jira-multi -s user -- node /path/to/claude-jira-multi/server/jira-mcp.mjs
```

## Configure

```bash
mkdir -p ~/.config/jira-multi
cp config.example/accounts.env.example ~/.config/jira-multi/accounts.env
cp config.example/map.env.example      ~/.config/jira-multi/map.env
```

**`accounts.env`** — one block per Atlassian login:

```ini
WORK_SITE=mycompany            # → mycompany.atlassian.net
WORK_EMAIL=me@mycompany.com
WORK_TOKEN=...                 # scripts/jira-token-add.sh work  (hidden input)

PERSONAL_SITE=myspace
PERSONAL_EMAIL=me@gmail.com
PERSONAL_TOKEN=...
```

One token per **login email** — it works on every site that email can access,
and `jira-token-add.sh` auto-fills all accounts sharing the email.

**`map.env`** — folder names → accounts (walked up from cwd, so it matches from
anywhere inside the repo):

```ini
default=work
my-backend=work:BACK           # also sets default project for issue creation
side-project=personal:SIDE:SIDE  # + Confluence space for roadmap-sync
```

Verify: ask Claude to run `jira_accounts` (shows token status and what the
current folder resolves to) and `jira_myself`.

## Tools

| Tool | What it does |
|---|---|
| `jira_accounts` | List accounts, token status, folder resolution |
| `jira_search` | JQL search (slim results) |
| `jira_issue` | One issue with description + recent comments |
| `jira_create_issue` | Create; project defaults from folder mapping; graceful issue-type fallback |
| `jira_update_issue` | Update raw fields |
| `jira_transition` | List or execute workflow transitions |
| `jira_comment` | Add a comment |
| `jira_myself` | Credential check |
| `jira_api` | Raw REST escape hatch — Jira `/rest/...` and Confluence `/wiki/...` |

Every tool takes an optional `account` to target any configured site.

## Skills (plugin install)

- **jira-setup** — configure accounts, store tokens safely, troubleshoot 401s
- **jira-init** — link a repo: create the Jira project if missing + write the mapping
- **jira-adhoc** — file bugs/issues from any folder; work an existing issue end-to-end; cross-site standup
- **jira-plan** — turn meeting notes/specs into scoped Jira tickets with acceptance criteria
- **jira-release** — draft release notes from a git range, cross-linked to the Jira issues in it
- **jira-sync** — push a `.planning/ROADMAP.md` (GSD convention) to Jira tasks + a Confluence status page
- **lark-setup / lark-tasks / lark-docs** — Lark Suite/Feishu task management and documentation (see below)

## Prompt recipes

In the style of the [Claude Code prompt library](https://code.claude.com/docs/en/prompt-library)
— copy, fill the slot, go:

```text
read PROJ-123, implement the fix, and run the tests
```

```text
file a bug for this stack trace with repro steps: <paste the actual trace>
```

```text
read meeting-notes.md and create a Jira ticket for each action item with acceptance criteria
```

```text
which files would I need to touch to <change>? file a ticket with the estimate
```

```text
draft release notes for v1.2.0..HEAD grouped by feature, fix, and breaking change, and link the Jira issues
```

```text
what's on my plate across all my Jira sites? group by site, priority first
```

That last one is the point of this plugin — a cross-account sweep no
single-site integration can do.

## Lark Suite / Feishu (tasks + docs)

Optional companion integration on the **official**
[`lark-openapi-mcp`](https://github.com/larksuite/lark-openapi-mcp) server —
this plugin adds the config, registration, and workflow skills:

```bash
cp config.example/lark.env.example ~/.config/jira-multi/lark.env
# fill in App ID/Secret from open.larksuite.com (or open.feishu.cn) + domain
scripts/lark-add.sh     # registers MCP server 'lark' with task+doc presets
```

- **lark-setup** — app creation, permissions (`task:task`, `docx:document`,
  `wiki:wiki`, `drive:drive`), tenant vs user token mode, troubleshooting
- **lark-tasks** — create/assign/remind/complete Lark tasks; mirror a Jira
  issue into Lark (`[KEY] summary`, one-way, Jira stays source of truth)
- **lark-docs** — search/read docs & wiki; publish markdown as Lark docs
  (release notes, status reports); share with view-only default

Upstream beta caveats: docs are import/read (no in-place editing), no file
upload/download. For living status pages use Confluence via jira-sync; use
Lark docs for point-in-time publishes.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/jira-token-add.sh <account>` | Paste a token (hidden input), auto-fill same-email accounts, verify |
| `scripts/jira-init.sh <repo> [acct[:KEY[:SPACE]]]` | Ensure Jira project exists + write folder mapping |
| `scripts/jira.sh <account> <METHOD> <path> [json]` | Raw curl wrapper for shells/cron |
| `scripts/roadmap-sync.mjs <repo> [--dry]` | Roadmap phases → Jira tasks (idempotent) + Confluence page |
| `scripts/lark-add.sh` | Register the official Lark MCP server from `lark.env` |

## Gotchas (learned the hard way)

- **401 is ambiguous.** Atlassian returns 401 both for bad credentials *and*
  for valid credentials that lack access to that site. If a token 401s
  everywhere, it may belong to a different login than you think — check the
  avatar on id.atlassian.com before creating tokens (SSO reuses the last
  session silently).
- **Search-index lag.** A JQL search right after creating an issue can miss it.
  `roadmap-sync` keeps a local key cache to stay idempotent.
- **Team-managed projects often lack a Bug type.** `jira_create_issue` falls
  back to an available type and adds a label instead of failing.
- **Tokens expire** (max 1 year). Re-run `jira-token-add.sh` to rotate.

## Security notes

- Tokens live only in `~/.config/jira-multi/accounts.env` (chmod 600), never in
  the repo, never sent anywhere except `https://<yoursite>.atlassian.net`.
- `jira-token-add.sh` reads tokens with hidden input so they don't land in
  shell history or terminal scrollback.
- The server is stdio-only: no ports, no telemetry, zero third-party packages.

## License

MIT
