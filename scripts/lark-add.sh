#!/usr/bin/env bash
# lark-add.sh — register the official Lark/Feishu MCP server (lark-openapi-mcp)
# for Claude Code, configured from ~/.config/jira-multi/lark.env.
#
# Prereqs: a Lark app (see config.example/lark.env.example), node/npx.
set -euo pipefail
CONF_DIR="${JIRA_MULTI_CONFIG:-$HOME/.config/jira-multi}"
ENVF="$CONF_DIR/lark.env"
[ -f "$ENVF" ] || { echo "missing $ENVF — copy config.example/lark.env.example there and fill it in"; exit 1; }
. "$ENVF"

[ -n "${LARK_APP_ID:-}" ] && [ -n "${LARK_APP_SECRET:-}" ] || { echo "LARK_APP_ID / LARK_APP_SECRET not set in $ENVF"; exit 1; }
DOMAIN="${LARK_DOMAIN:-https://open.feishu.cn}"
TOOLS="${LARK_TOOLS:-preset.task.default,preset.doc.default}"
MODE="${LARK_TOKEN_MODE:-tenant}"

args=(npx -y @larksuiteoapi/lark-mcp mcp -a "$LARK_APP_ID" -s "$LARK_APP_SECRET" --domain "$DOMAIN" -t "$TOOLS")
if [ "$MODE" = "user" ]; then
  args+=(--oauth --token-mode user_access_token)
  echo "user token mode: complete the one-time OAuth login first if you haven't:"
  echo "  npx -y @larksuiteoapi/lark-mcp login -a $LARK_APP_ID -s <secret> --domain $DOMAIN"
fi

claude mcp remove lark -s user >/dev/null 2>&1 || true
claude mcp add lark -s user -- "${args[@]}"
chmod 600 "$ENVF"
echo "registered MCP server 'lark' (user scope, tools: $TOOLS)."
echo "note: the app secret is stored in ~/.claude.json by claude mcp — local file, keep it private."
echo "restart your Claude Code session, then verify with the lark tools (e.g. search a doc)."
