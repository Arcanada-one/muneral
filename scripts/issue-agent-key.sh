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
# New directories and API response files must be private from creation.
umask 077

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

# Refuse any existing destination, including a dangling final symlink. Never
# truncate an existing key or rely on chmod after its contents have been written.
if [ -e "$OUT" ] || [ -L "$OUT" ]; then
  printf '%s\n' 'refusing existing --out; choose a new protected filename' >&2
  exit 2
fi

# Refuse writing into a git tree (including linked worktrees/submodules, whose
# .git marker is a file). Resolve symlinked parents before walking ancestors.
out_dir=$(dirname -- "$OUT")
mkdir -p -- "$out_dir"
resolved_out=$(cd -- "$out_dir" && pwd -P)/$(basename -- "$OUT")
probe="$resolved_out"
while [ "$probe" != "/" ]; do
  if [ -e "$probe/.git" ] || [ -L "$probe/.git" ]; then
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
import json, os, sys, uuid
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
# Pin the destination directory: a later path/symlink swap must not redirect
# the write. Recheck git ancestry at publication time using directory handles.
parent, filename = os.path.split(out_path)
directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
directory_fd = os.open(parent, directory_flags)
staging = None
try:
    probe_fd = os.dup(directory_fd)
    try:
        while True:
            try:
                os.stat('.git', dir_fd=probe_fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise SystemExit('refusing --out inside a git work tree')
            upper_fd = os.open('..', directory_flags, dir_fd=probe_fd)
            here, upper = os.fstat(probe_fd), os.fstat(upper_fd)
            if (here.st_dev, here.st_ino) == (upper.st_dev, upper.st_ino):
                os.close(upper_fd)
                break
            os.close(probe_fd)
            probe_fd = upper_fd
    finally:
        os.close(probe_fd)

    # The staging file is 0600 before the first plaintext byte. Publish only
    # after flush/fsync, via an atomic no-clobber link, never rename/replace.
    candidate = '.muneral-key-' + uuid.uuid4().hex
    fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=directory_fd)
    staging = candidate
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        os.fchmod(fh.fileno(), 0o600)
        fh.write(body)
        fh.flush()
        os.fsync(fh.fileno())
    try:
        os.link(staging, filename, src_dir_fd=directory_fd,
                dst_dir_fd=directory_fd, follow_symlinks=False)
    except FileExistsError:
        raise SystemExit('refusing existing --out; destination appeared during issuance')
    os.unlink(staging, dir_fd=directory_fd)
    staging = None
    try:
        # Sync both publication and removal of the staging name.
        os.fsync(directory_fd)
    except OSError:
        print(f'agentId={agent_id}\nkeyId={key_id}\nout={out_path}', file=sys.stderr)
        raise SystemExit('credential file published with mode 0600, but durability '
                         'confirmation failed; inspect --out before retrying')
finally:
    try:
        if staging is not None:
            os.unlink(staging, dir_fd=directory_fd)
    finally:
        os.close(directory_fd)
print(f"agentId={agent_id}")
print(f"keyId={key_id}")
print(f"out={out_path}")
PY

