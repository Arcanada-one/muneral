#!/usr/bin/env bash
# Contract test for the `agent.tasks.contract_digest` probe in scripts/probe-endpoints.sh (A2-267).
#
# The probe exists to notice a build that does NOT carry the task contract digest: an agent-task list
# whose rows have no `contractDigest` key reads, to a consumer's `.get("contractDigest")`, exactly
# like a task with no contract. So this test serves the answers a wrong build gives from a loopback
# stub and asserts the probe goes RED on each — and serves the right answers to prove it is not red
# on everything. Same shape as probe-health-identity.test.sh, for the same reason: a probe is a
# verifier, and a verifier needs a verifier of its own.
#
# No Muneral, no database, no network beyond loopback.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$HERE/../probe-endpoints.sh"
[ -x "$PROBE" ] || { echo "probe script not executable: $PROBE" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null' EXIT

D_A="sha256:$(printf 'a1%.0s' $(seq 1 32))"
SHA='1111111111111111111111111111111111111111'

# /health is a good build, so every other probe is green and the exit code speaks about the case
# alone. /api/v1/agents/tasks answers whatever the case wrote to $WORK/tasks.json. /api/v1/tasks is
# closed (401), which the probe records as not_measured for the status probes, never as a failure.
cat > "$WORK/stub.py" <<'PY'
import http.server, sys, pathlib

TASKS = pathlib.Path(sys.argv[1])
HEALTH = sys.argv[3].encode()


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path == '/health':
            code, payload = 200, HEALTH
        elif self.path == '/api/v1/agents/tasks':
            code, payload = 200, TASKS.read_bytes()
        elif self.path.startswith('/api/v1/tasks'):
            code, payload = 401, b'{"message":"Unauthorized"}'
        else:
            code, payload = 404, b'{"message":"Not Found"}'
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *a):  # silence
        pass


http.server.HTTPServer(('127.0.0.1', int(sys.argv[2])), H).serve_forever()
PY

PORT="$(python3 -c 'import socket
s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
BASE="http://127.0.0.1:$PORT"

printf '[]' > "$WORK/tasks.json"
python3 "$WORK/stub.py" "$WORK/tasks.json" "$PORT" \
  "{\"status\":\"ok\",\"version\":\"0.4.6\",\"build\":{\"sha\":\"$SHA\",\"source\":\"MUNERAL_BUILD_SHA\"}}" &
STUB_PID=$!

for _ in $(seq 1 50); do
  curl -fsS -m 2 "$BASE/health" > /dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS -m 2 "$BASE/health" > /dev/null 2>&1 || { echo "stub never came up on $BASE" >&2; exit 2; }

FAILURES=0

# run_case <name> <tasks-json> <agent-key-or-empty> <expected-exit> <expected-verdict>
run_case() {
  local name="$1" body="$2" key="$3" want_exit="$4" want="$5"
  printf '%s' "$body" > "$WORK/tasks.json"

  local -a args=(--base "$BASE" --json "$WORK/observed.json")
  local out rc got
  out="$(MUNERAL_AGENT_KEY="$key" bash "$PROBE" "${args[@]}" 2>&1)"
  rc=$?
  got="$(printf '%s\n' "$out" | awk '$1 == "agent.tasks.contract_digest" { print $2; exit }')"

  local bad=0
  if [ "$got" != "$want" ]; then
    echo "  FAIL $name: agent.tasks.contract_digest is '${got:-<absent>}', expected '$want'"
    bad=1
  fi
  if [ "$rc" != "$want_exit" ]; then
    echo "  FAIL $name: probe exit $rc, expected $want_exit"
    bad=1
  fi
  python3 -c '
import json, sys
rows = json.load(open(sys.argv[1], encoding="utf-8"))["observed"]
hit = [r for r in rows if r["probe"] == "agent.tasks.contract_digest"]
sys.exit(0 if hit and hit[0]["verdict"] == sys.argv[2] else 1)
' "$WORK/observed.json" "$want" || {
    echo "  FAIL $name: observed.json does not record agent.tasks.contract_digest=$want"
    bad=1
  }
  if [ "$bad" = 0 ]; then
    echo "  ok   $name"
  else
    FAILURES=$((FAILURES + 1))
    printf '%s\n' "$out" | sed 's/^/       | /'
  fi
}

KEY='stub-agent-key-not-a-credential'

echo "probe-contract-digest: stub on $BASE"

# --- green: the key is on every row, bound or null ---------------------------
run_case 'a bound digest and a null one are both verified' \
  "[{\"task\":{\"id\":\"t1\",\"contractDigest\":\"$D_A\"}},{\"task\":{\"id\":\"t2\",\"contractDigest\":null}}]" \
  "$KEY" 0 verified

# --- red: a build without the field, or with a malformed value ---------------
run_case 'a row with no contractDigest key is a failure, not "no contract"' \
  '[{"task":{"id":"t1","status":"todo"}}]' \
  "$KEY" 1 failed

run_case 'one row missing the key among good rows is still a failure' \
  "[{\"task\":{\"id\":\"t1\",\"contractDigest\":\"$D_A\"}},{\"task\":{\"id\":\"t2\"}}]" \
  "$KEY" 1 failed

run_case 'an uppercase digest is refused' \
  "[{\"task\":{\"id\":\"t1\",\"contractDigest\":\"sha256:$(printf 'A1%.0s' $(seq 1 32))\"}}]" \
  "$KEY" 1 failed

run_case 'a digest with a trailing newline is refused' \
  "[{\"task\":{\"id\":\"t1\",\"contractDigest\":\"$D_A\\n\"}}]" \
  "$KEY" 1 failed

run_case 'a bare hex string with no algorithm is refused' \
  "[{\"task\":{\"id\":\"t1\",\"contractDigest\":\"$(printf 'a1%.0s' $(seq 1 32))\"}}]" \
  "$KEY" 1 failed

# --- the third verdict -------------------------------------------------------
run_case 'an empty list observes nothing about the field' \
  '[]' "$KEY" 0 not_measured

run_case 'no agent key observes nothing about the field' \
  "[{\"task\":{\"id\":\"t1\"}}]" '' 0 not_measured

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "probe-contract-digest: all cases hold"
  exit 0
fi
echo "probe-contract-digest: $FAILURES case(s) did not hold"
exit 1
