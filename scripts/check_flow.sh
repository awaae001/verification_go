#!/usr/bin/env bash
# Creates a verification session, prints the URL, then polls until it is verified.
#
#   scripts/check_flow.sh
#   BASE_URL=http://127.0.0.1:10014 scripts/check_flow.sh

set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
CONFIG_FILE=${CONFIG_FILE:-$ROOT_DIR/data/system_config.json}
BASE_URL=${BASE_URL:-http://127.0.0.1:10014}
CLIENT_KEY=${CLIENT_KEY:-$(jq -r '.system_conf.trusted_client_keys | to_entries[0].value' "$CONFIG_FILE")}

session=$(curl -sS -X POST -H "X-Client-Key: $CLIENT_KEY" "$BASE_URL/api/sessions")
session_id=$(jq -r '.session_id // empty' <<<"$session")
if [[ -z $session_id ]]; then
	printf 'failed to create a session: %s\n' "$session" >&2
	exit 1
fi

printf '\nOpen this URL and complete the four steps:\n\n  %s\n\nPolling %s\n\n' \
	"$(jq -r .verify_url <<<"$session")" "$session_id"

while true; do
	body=$(curl -sS -H "X-Client-Key: $CLIENT_KEY" "$BASE_URL/api/sessions/$session_id/status")
	case $(jq -r '.status // .code // "unknown"' <<<"$body") in
	pending) sleep 10 ;;
	verified)
		printf 'verified: %s\n' "$(jq -c '{user_id, user_name}' <<<"$body")"
		exit 0
		;;
	*)
		printf 'stopped: %s\n' "$body"
		exit 1
		;;
	esac
done
