#!/usr/bin/env bash
# Contract test for the /health identity probes in scripts/probe-endpoints.sh.
#
# WHY THIS EXISTS (A2-251 §7.1, A2-255). The version probe used to compare the reported version
# against the string "unknown", while the controller's sentinel for an unresolvable manifest is
# "0.0.0-unknown" (apps/api/src/health.controller.ts). A2-251 mutated apps/api/package.json to
# `version: ""`, /health answered `0.0.0-unknown`, and the probe recorded it as
# `health.version verified` — the one check whose whole purpose is to notice that could not go red.
#
# So this test does not check that the probe passes against a good build. It checks that the probe
# FAILS against every build that cannot name itself, by serving those answers from a stub and
# reading the verdicts back. A green probe suite is worth what its red cases are worth.
#
# No Muneral, no database and no network beyond loopback: the stub is the service under test here,
# because the thing under test is the probe.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$HERE/../probe-endpoints.sh"
[ -x "$PROBE" ] || { echo "probe script not executable: $PROBE" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null' EXIT

SHA_A='1111111111111111111111111111111111111111'
SHA_B='2222222222222222222222222222222222222222'

# The stub answers /health with whatever body the case wrote to $WORK/body.json, refuses
# /api/v1/tasks with 401 and 404s everything else — so a case that mutates only /health leaves every
# other probe green and the run's exit code speaks about the mutation alone.
cat > "$WORK/stub.py" <<'PY'
import http.server, sys, pathlib

BODY = pathlib.Path(sys.argv[1])


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path == '/health':
            payload = BODY.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
        elif self.path.startswith('/api/v1/tasks'):
            payload = b'{"message":"Unauthorized"}'
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
        else:
            payload = b'{"message":"Not Found"}'
            self.send_response(404)
            self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *a):  # silence
        pass


port = int(sys.argv[2])
http.server.HTTPServer(('127.0.0.1', port), H).serve_forever()
PY

# A free loopback port, asked for from the kernel rather than guessed: CI runners share a host and a
# hard-coded port is how a suite starts failing for a reason that has nothing to do with it.
PORT="$(python3 -c 'import socket
s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
BASE="http://127.0.0.1:$PORT"

printf '{"status":"ok"}' > "$WORK/body.json"
python3 "$WORK/stub.py" "$WORK/body.json" "$PORT" &
STUB_PID=$!

for _ in $(seq 1 50); do
  curl -fsS -m 2 "$BASE/health" > /dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS -m 2 "$BASE/health" > /dev/null 2>&1 || { echo "stub never came up on $BASE" >&2; exit 2; }

FAILURES=0

# run_case <name> <body-json> <expect-commit-or-empty> <expected-exit> <probe=verdict>...
run_case() {
  local name="$1" body="$2" expect="$3" want_exit="$4"
  shift 4
  printf '%s' "$body" > "$WORK/body.json"

  local -a args=(--base "$BASE" --json "$WORK/observed.json")
  [ -n "$expect" ] && args+=(--expect-commit "$expect")

  local out rc
  out="$(bash "$PROBE" "${args[@]}" 2>&1)"
  rc=$?

  local bad=0
  local pair probe want got
  for pair in "$@"; do
    probe="${pair%%=*}"
    want="${pair#*=}"
    got="$(printf '%s\n' "$out" | awk -v p="$probe" '$1 == p { print $2; exit }')"
    if [ "$got" != "$want" ]; then
      echo "  FAIL $name: $probe is '${got:-<absent>}', expected '$want'"
      bad=1
    fi
  done
  if [ "$rc" != "$want_exit" ]; then
    echo "  FAIL $name: probe exit $rc, expected $want_exit"
    bad=1
  fi
  # The JSON the probe writes is what a receipt quotes, so the verdict has to be there too and not
  # only on the terminal: a receipt built from a file that disagrees with the console is unusable.
  for pair in "$@"; do
    probe="${pair%%=*}"
    want="${pair#*=}"
    python3 -c '
import json, sys
rows = json.load(open(sys.argv[1], encoding="utf-8"))["observed"]
hit = [r for r in rows if r["probe"] == sys.argv[2]]
sys.exit(0 if hit and hit[0]["verdict"] == sys.argv[3] else 1)
' "$WORK/observed.json" "$probe" "$want" || {
      echo "  FAIL $name: observed.json does not record $probe=$want"
      bad=1
    }
  done

  if [ "$bad" = 0 ]; then
    echo "  ok   $name"
  else
    FAILURES=$((FAILURES + 1))
    printf '%s\n' "$out" | sed 's/^/       | /'
  fi
}

echo "probe-health-identity: stub on $BASE"

# --- the green case, so the red ones mean something --------------------------
run_case 'a release and a full commit are verified' \
  "{\"status\":\"ok\",\"version\":\"0.4.6\",\"build\":{\"sha\":\"$SHA_A\",\"source\":\"MUNERAL_BUILD_SHA\"}}" \
  '' 0 health.serves=verified health.version=verified health.commit=verified

# --- the version half: every build that cannot name its release must go red ---
run_case 'the controller sentinel is not a version (A2-251 mutant 3)' \
  "{\"status\":\"ok\",\"version\":\"0.0.0-unknown\",\"build\":{\"sha\":\"$SHA_A\",\"source\":\"MUNERAL_BUILD_SHA\"}}" \
  '' 1 health.version=failed health.commit=verified

run_case 'an empty version is not a version' \
  "{\"status\":\"ok\",\"version\":\"\",\"build\":{\"sha\":\"$SHA_A\",\"source\":\"MUNERAL_BUILD_SHA\"}}" \
  '' 1 health.version=failed

run_case 'a bare word is not a version' \
  "{\"status\":\"ok\",\"version\":\"unknown\",\"build\":{\"sha\":\"$SHA_A\",\"source\":\"MUNERAL_BUILD_SHA\"}}" \
  '' 1 health.version=failed

run_case 'an absent version is not a version' \
  "{\"status\":\"ok\",\"build\":{\"sha\":\"$SHA_A\",\"source\":\"MUNERAL_BUILD_SHA\"}}" \
  '' 1 health.version=failed

# --- the commit half ---------------------------------------------------------
run_case 'a /health with no build object is a failure, not a gap' \
  '{"status":"ok","version":"0.4.6"}' \
  '' 1 health.version=verified health.commit=failed

run_case 'a truncated sha is refused' \
  '{"status":"ok","version":"0.4.6","build":{"sha":"1111111","source":"MUNERAL_BUILD_SHA"}}' \
  '' 1 health.commit=failed

run_case 'a sha that is not hex is refused' \
  '{"status":"ok","version":"0.4.6","build":{"sha":"zzzz111111111111111111111111111111111111","source":"MUNERAL_BUILD_SHA"}}' \
  '' 1 health.commit=failed

run_case 'null sha with a reason is the third verdict, not a pass' \
  '{"status":"ok","version":"0.4.6","build":{"sha":null,"source":null,"problem":"MUNERAL_BUILD_SHA is not set"}}' \
  '' 0 health.commit=not_measured

# --- --expect-commit turns the shape check into a gate -----------------------
run_case 'the expected commit is verified' \
  "{\"status\":\"ok\",\"version\":\"0.4.6\",\"build\":{\"sha\":\"$SHA_A\",\"source\":\"MUNERAL_BUILD_SHA\"}}" \
  "$SHA_A" 0 health.commit=verified

run_case 'a different commit is a failure' \
  "{\"status\":\"ok\",\"version\":\"0.4.6\",\"build\":{\"sha\":\"$SHA_B\",\"source\":\"MUNERAL_BUILD_SHA\"}}" \
  "$SHA_A" 1 health.commit=failed

run_case 'an expected commit the service cannot confirm is a failure, not a gap' \
  '{"status":"ok","version":"0.4.6","build":{"sha":null,"source":null,"problem":"MUNERAL_BUILD_SHA is not set"}}' \
  "$SHA_A" 1 health.commit=failed

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "probe-health-identity: all cases hold"
  exit 0
fi
echo "probe-health-identity: $FAILURES case(s) did not hold"
exit 1
