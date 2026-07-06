#!/usr/bin/env bash
# jira-token-add.sh [account] — paste an Atlassian API token into accounts.env
# without it touching shell history or terminal scrollback (hidden input).
#
# One token per LOGIN EMAIL works on every site that email can access, so this
# script auto-fills the token for every configured account sharing the same email.
#
# Create tokens at: https://id.atlassian.com/manage-profile/security/api-tokens
# (log in as the account's email first — SSO silently reuses the wrong account
# otherwise; use an incognito window).
set -euo pipefail
CONF_DIR="${JIRA_MULTI_CONFIG:-$HOME/.config/jira-multi}"
ENVF="${ATLASSIAN_ENV:-$CONF_DIR/accounts.env}"
[ -f "$ENVF" ] || { echo "missing $ENVF — copy config.example/accounts.env.example there first"; exit 1; }

acct="${1:-}"
if [ -z "$acct" ]; then
  echo "Configured accounts:"
  grep -E '^[A-Z0-9_]+_SITE=' "$ENVF" | sed 's/_SITE=/ → /' | tr '[:upper:]' '[:lower:]' | sed 's/^/  /'
  printf "Account: "; read -r acct
fi
acct="$(echo "$acct" | tr '[:upper:]' '[:lower:]')"
ACCT="$(echo "$acct" | tr '[:lower:]' '[:upper:]')"

email="$(grep "^${ACCT}_EMAIL=" "$ENVF" | head -1 | cut -d= -f2- || true)"
[ -n "$email" ] || { echo "account '$acct' not in $ENVF (need ${ACCT}_SITE/_EMAIL first)"; exit 1; }

printf "Paste API token for '%s' <%s> (input hidden): " "$acct" "$email"
read -rs token; echo
[ -n "$token" ] || { echo "empty token, aborting"; exit 1; }

set_token() {
  local name="${1}_TOKEN"
  if grep -q "^#*${name}=" "$ENVF"; then
    sed -i.bak "s|^#*${name}=.*|${name}=${token}|" "$ENVF" && rm -f "$ENVF.bak"
  else
    echo "${name}=${token}" >> "$ENVF"
  fi
  echo "  ${name} set"
}

# fill every account that logs in with the same email (same token works)
for other in $(grep -E '^[A-Z0-9_]+_EMAIL=' "$ENVF" | awk -F'_EMAIL=' -v e="$email" '$2==e {print $1}'); do
  set_token "$other"
done
chmod 600 "$ENVF"

echo "Verifying against Jira..."
"$(dirname "$0")/jira.sh" "$acct" GET '/rest/api/3/myself' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.displayName?`  OK: ${j.displayName} <${j.emailAddress||""}>`:`  FAILED: ${s.slice(0,200)}`)}catch{console.log("  FAILED:",s.slice(0,200))}})'
