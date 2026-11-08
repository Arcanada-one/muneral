#!/usr/bin/env bash
# issue-agent-key — mint one mun_sk_ for one agents row via human JWT (MUN-0066).
#
# Creates an agents row, mints a key, and writes the plaintext ONLY to --out.
# Refuses to run without --out, refuses paths inside a git work tree, and never
# prints the raw key to stdout/stderr. Secrets stay out of git and logs.
#
# Usage:
#   MUNERAL_JWT=<access_token> scripts/issue-agent-key.sh \
#     --workspace-id <uuid> --name <runtime-name> --out /abs/path/to/file.key \
#     [--label <label>] [--model <model>] [--provider <provider>] \
#     [--base https://api.muneral.com/api/v1]
#
# Exit: 0 on success; 2 on usage/policy refusal; 1 on API/transport failure.
set -euo pipefail

BASE="${MUNERAL_API_BASE:-https://api.muneral.com/api/v1}"
JWT="${MUNERAL_JWT:-}"
WORKSPACE_ID=""
NAME=""
LABEL=""
MODEL=""
PROVIDER=""
OUT=""
UA="aup-orchestrator/1.0"

usage() {
  sed -n '2,16p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --workspace-id) WORKSPACE_ID="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --provider) PROVIDER="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [ -z "$JWT" ]; then
  printf 'MUNERAL_JWT is required (human access token; never an agent key)\n' >&2
  exit 2
fi
if [ -z "$WORKSPACE_ID" ] || [ -z "$NAME" ] || [ -z "$OUT" ]; then
  printf '--workspace-id, --name and --out are required\n' >&2
  usage >&2
  exit 2
fi
case "$OUT" in
  /*) ;;
  *) printf '%s\n' '--out must be an absolute path' >&2; exit 2 ;;
esac

# Refuse writing into a tracked git tree (including this clone).
out_dir=$(dirname -- "$OUT")
mkdir -p -- "$out_dir"
resolved_out=$(cd -- "$out_dir" && pwd -P)/$(basename -- "$OUT")
probe="$resolved_out"
while [ "$probe" != "/" ]; do
  if [ -d "$probe/.git" ]; then
    printf 'refusing --out inside a git work tree (%s); use config/credentials/ or another protected path outside git\n' "$probe" >&2
    exit 2
  fi
  probe=$(dirname -- "$probe")
done

tmp_agent=$(mktemp)
tmp_key=$(mktemp)
cleanup() {
  rm -f -- "$tmp_agent" "$tmp_key"
}
trap cleanup EXIT

agent_body=$(printf '{"workspaceId":"%s","name":"%s"' "$WORKSPACE_ID" "$NAME")
if [ -n "$MODEL" ]; then
  agent_body=$(printf '%s,"model":"%s"' "$agent_body" "$MODEL")
fi
if [ -n "$PROVIDER" ]; then
  agent_body=$(printf '%s,"provider":"%s"' "$agent_body" "$PROVIDER")
fi
agent_body=$(printf '%s}' "$agent_body")

http_agent=$(curl -sS -o "$tmp_agent" -w '%{http_code}' \
  -X POST "$BASE/agents" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $UA" \
  -d "$agent_body")
if [ "$http_agent" != "201" ] && [ "$http_agent" != "200" ]; then
  printf 'POST /agents failed: HTTP %s (body not printed; may contain details)\n' "$http_agent" >&2
  exit 1
fi

agent_id=$(python3 - <<'PY' "$tmp_agent"
import json,sys
print(json.load(open(sys.argv[1])).get("id",""))
PY
)
if [ -z "$agent_id" ]; then
  printf 'POST /agents returned no id\n' >&2
  exit 1
fi

if [ -n "$LABEL" ]; then
  key_body=$(printf '{"label":"%s"}' "$LABEL")
else
  key_body='{}'
fi

http_key=$(curl -sS -o "$tmp_key" -w '%{http_code}' \
  -X POST "$BASE/agents/${agent_id}/keys" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $UA" \
  -d "$key_body")
if [ "$http_key" != "201" ] && [ "$http_key" != "200" ]; then
  printf 'POST /agents/%s/keys failed: HTTP %s\n' "$agent_id" "$http_key" >&2
  exit 1
fi

python3 - <<'PY' "$tmp_key" "$resolved_out" "$agent_id" "$NAME"
import json, os, sys, stat
payload = json.load(open(sys.argv[1]))
out_path, agent_id, name = sys.argv[2], sys.argv[3], sys.argv[4]
key = payload.get("key") or ""
key_id = payload.get("keyId") or payload.get("id") or ""
if not key.startswith("mun_sk_") or not key_id:
    raise SystemExit("key response missing mun_sk_ key or keyId")
# Write only to the protected file; never print the key.
body = (
    f"# Muneral per-runtime agent key (MUN-0066). Mode 0600. Do not commit.\n"
    f"agent_id={agent_id}\n"
    f"agent_name={name}\n"
    f"key_id={key_id}\n"
    f"mun_sk={key}\n"
)
fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    fh.write(body)
os.chmod(out_path, stat.S_IRUSR | stat.S_IWUSR)
print(f"agentId={agent_id}")
print(f"keyId={key_id}")
print(f"out={out_path}")
PY
