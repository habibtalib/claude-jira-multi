#!/usr/bin/env bash
# jira-init.sh <repo-dir> [account[:PROJECTKEY[:SPACEKEY]]] [--dry]
# Link a folder/repo to a Jira site: ensure the Jira project exists (create a
# company-managed kanban project if missing) and write the folder→account
# mapping into map.env so jira-multi auto-resolves it from then on.
#
# Default account = `default=` in map.env, else the only configured account.
#
#   jira-init.sh ~/code/new-thing                 → default account, key from name
#   jira-init.sh ~/code/new-thing work:NT         → 'work' account, key NT
#   jira-init.sh ~/code/new-thing work:NT:NT      → + Confluence space mapping
set -euo pipefail
CONF_DIR="${JIRA_MULTI_CONFIG:-$HOME/.config/jira-multi}"
ENVF="${ATLASSIAN_ENV:-$CONF_DIR/accounts.env}"
MAPF="${JIRA_MAP:-$CONF_DIR/map.env}"
JIRA="$(dirname "$0")/jira.sh"
[ -f "$MAPF" ] || touch "$MAPF"

repo_dir="${1:?usage: jira-init.sh <repo-dir> [account[:PROJECTKEY[:SPACEKEY]]] [--dry]}"
spec="${2:-}"
DRY=0; case "${2:-} ${3:-}" in *--dry*) DRY=1;; esac
case "$spec" in --dry) spec="";; esac

# first-run guard: no accounts configured at all → route to setup
n_accounts=$(grep -cE '^[A-Z0-9_]+_SITE=' "$ENVF" 2>/dev/null || true)
if [ "${n_accounts:-0}" -eq 0 ]; then
  echo "no Atlassian accounts configured yet ($ENVF)."
  echo "First-time setup:"
  echo "  1. mkdir -p $CONF_DIR && cp <plugin>/config.example/accounts.env.example $ENVF"
  echo "  2. edit $ENVF: set <NAME>_SITE and <NAME>_EMAIL for each Atlassian login"
  echo "  3. $(dirname "$0")/jira-token-add.sh <name>   # paste API token (create at"
  echo "     https://id.atlassian.com/manage-profile/security/api-tokens while logged in as that email)"
  echo "Then re-run jira-init. (In Claude Code: run the jira-setup skill.)"
  exit 1
fi

# default account: map.env default=, else the single configured account
if [ -z "$spec" ]; then
  spec="$(grep '^default=' "$MAPF" | head -1 | cut -d= -f2- | cut -d: -f1 || true)"
  if [ -z "$spec" ]; then
    if [ "$n_accounts" = 1 ]; then
      spec="$(grep -E '^[A-Z0-9_]+_SITE=' "$ENVF" | sed 's/_SITE=.*//' | tr '[:upper:]' '[:lower:]')"
    else
      echo "multiple accounts configured — pass one: jira-init.sh <repo> <account>[:KEY[:SPACE]]"
      echo "(or set 'default=<account>' in $MAPF)"; exit 1
    fi
  fi
fi

repo="$(basename "$(cd "$repo_dir" && pwd)")"
account="${spec%%:*}"; rest="${spec#*:}"
key=""; space=""
if [ "$rest" != "$spec" ]; then key="${rest%%:*}"; r2="${rest#*:}"; [ "$r2" != "$rest" ] && space="$r2"; fi

# derive a project key from the repo name if not given: letters/digits, upper, ≤8
if [ -z "$key" ]; then
  key="$(echo "$repo" | tr -cd '[:alnum:]' | tr '[:lower:]' '[:upper:]' | cut -c1-8)"
  case "$key" in [0-9]*) key="P$key"; key="$(echo "$key" | cut -c1-8)";; esac
fi

# existing mapping wins
if grep -q "^${repo}=" "$MAPF" 2>/dev/null; then
  echo "already mapped: $(grep "^${repo}=" "$MAPF")"
  exit 0
fi

echo "$repo → account=$account project=$key${space:+ space=$space}"
if [ "$DRY" = 1 ]; then
  echo "[dry] would ensure Jira project $key exists on '$account' and append '$repo=$account:$key${space:+:$space}' to $MAPF"
  exit 0
fi

# token present for this account?
ACCT="$(echo "$account" | tr '[:lower:]' '[:upper:]')"
if ! grep -qE "^${ACCT}_TOKEN=..+" "$ENVF"; then
  echo "account '$account' has no API token yet — run: $(dirname "$0")/jira-token-add.sh $account"
  echo "(create the token at https://id.atlassian.com/manage-profile/security/api-tokens while logged in as that account's email)"
  exit 1
fi

# ensure project exists (create company-managed kanban if missing)
if "$JIRA" "$account" GET "/rest/api/3/project/$key" | grep -q '"key"'; then
  echo "  = Jira project $key exists"
else
  lead="$("$JIRA" "$account" GET '/rest/api/3/myself' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).accountId))')"
  out="$("$JIRA" "$account" POST '/rest/api/3/project' "{\"key\":\"$key\",\"name\":\"$repo\",\"projectTypeKey\":\"software\",\"projectTemplateKey\":\"com.pyxis.greenhopper.jira:gh-simplified-agility-kanban\",\"leadAccountId\":\"$lead\",\"assigneeType\":\"UNASSIGNED\"}")"
  if echo "$out" | grep -q '"key"'; then
    echo "  + Jira project $key created ($repo)"
  else
    echo "  ! create failed (need project-create permission?): $(echo "$out" | head -c 300)"; exit 1
  fi
fi

printf '%s=%s:%s%s\n' "$repo" "$account" "$key" "${space:+:$space}" >> "$MAPF"
echo "  + mapping added: $repo=$account:$key${space:+:$space}"
