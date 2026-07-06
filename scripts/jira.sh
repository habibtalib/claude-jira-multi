#!/usr/bin/env bash
# jira.sh <account> <METHOD> <path> [json-body] — Jira/Confluence REST for
# scripts and headless runs (API tokens, no OAuth). Accounts in accounts.env.
#
#   jira.sh work GET  '/rest/api/3/myself'
#   jira.sh work POST '/rest/api/3/issue' '{"fields":{...}}'
#   jira.sh personal GET '/wiki/rest/api/space'          # Confluence: /wiki/...
set -euo pipefail
CONF_DIR="${JIRA_MULTI_CONFIG:-$HOME/.config/jira-multi}"
ENVF="${ATLASSIAN_ENV:-$CONF_DIR/accounts.env}"
[ -f "$ENVF" ] || { echo "missing $ENVF (copy config.example/accounts.env.example)"; exit 1; }
. "$ENVF"

acct="$(echo "${1:?account}" | tr '[:lower:]' '[:upper:]')"; method="${2:?METHOD}"; path="${3:?path}"; body="${4:-}"
site="$(eval echo "\${${acct}_SITE:-}")"; email="$(eval echo "\${${acct}_EMAIL:-}")"; token="$(eval echo "\${${acct}_TOKEN:-}")"
[ -n "$site" ] && [ -n "$email" ] && [ -n "$token" ] || { echo "account '$1' not configured in $ENVF (need ${acct}_SITE/_EMAIL/_TOKEN)"; exit 1; }

args=(-s -u "$email:$token" -H "Accept: application/json" -X "$method" "https://$site.atlassian.net$path")
[ -n "$body" ] && args+=(-H "Content-Type: application/json" -d "$body")
curl "${args[@]}"
