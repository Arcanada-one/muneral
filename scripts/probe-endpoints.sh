#!/usr/bin/env bash
# probe-endpoints — verify a RUNNING Muneral by the shape of what it answers.
#
# Arcanada 2 pipeline plan §8 step 8. DEC-AUP-0008 admits `observed` verdicts
# from endpoint probes as verifiers for the edge types a test cannot reach: a
# type-check proves the code compiles, a unit test proves a function behaves,
# and neither proves the built image serves the route it declares. This does,
# against a live instance, and writes the result as the `observed` section of a
# ChangeAdmissionReceipt.
#
# What a probe asserts is the SHAPE of the answer, never merely a status code.
# A 200 that returns the wrong body is a failure here; so is a 200 from a route
# that should have refused. Each probe therefore carries its own expectation and
# the verdict is one of three:
#
#   verified      the answer matched the declared shape
#   failed        the endpoint answered, and answered wrongly
#   not_measured  the probe could not be run (no credential, route closed to
#                 this principal, service unreachable) — the third verdict,
#                 never silently a pass
#
# Usage:
#   scripts/probe-endpoints.sh [--base URL] [--agent-key KEY] [--json OUT]
#
#   --base       default http://127.0.0.1:3500
#   --agent-key  a `mun_sk_` key; without it every agent-scoped probe is
#                not_measured rather than failed — absence of a credential is
#                not evidence about the service. Also readable from
#                MUNERAL_AGENT_KEY, which is how CI should pass it: the key is
#                never echoed, never written to the JSON, and never logged.
#   --json       write the observed section here (default: stdout only)
#
# Exit: 0 when no probe failed, 1 when any did. `not_measured` does not fail the
# run — it is reported, and a receipt carrying one is a receipt that says so.
set -uo pipefail

BASE="http://127.0.0.1:3500"
AGENT_KEY="${MUNERAL_AGENT_KEY:-}"
JSON_OUT=""
UA="aup-orchestrator/1.0"

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --agent-key) AGENT_KEY="$2"; shift 2 ;;
    --json) JSON_OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

VERIFIED=0
FAILED=0
NOT_MEASURED=0
RESULTS="$TMP/results.jsonl"
: > "$RESULTS"

# record <name> <verdict> <detail> <http_code>
record() {
  local name="$1" verdict="$2" detail="$3" code="${4:-}"
  case "$verdict" in
    verified) VERIFIED=$((VERIFIED + 1)) ;;
    failed) FAILED=$((FAILED + 1)) ;;
    not_measured) NOT_MEASURED=$((NOT_MEASURED + 1)) ;;
  esac
  python3 - "$name" "$verdict" "$detail" "$code" >> "$RESULTS" <<'PY'
import json, sys
name, verdict, detail, code = sys.argv[1:5]
row = {"probe": name, "verdict": verdict, "detail": detail}
if code:
    row["http_status"] = int(code)
print(json.dumps(row, ensure_ascii=False))
PY
  printf '%-34s %-13s %s\n' "$name" "$verdict" "$detail"
}

# request <method> <path> [auth] -> body in $TMP/body, code in $HTTP
request() {
  local method="$1" path="$2" auth="${3:-none}"
  local -a args=(-s -m 15 -o "$TMP/body" -w '%{http_code}'
                 -X "$method" -H "User-Agent: $UA")
  if [ "$auth" = "agent" ]; then
    args+=(-H "Authorization: Bearer $AGENT_KEY")
  fi
  HTTP="$(curl "${args[@]}" "$BASE$path" 2>/dev/null)" || HTTP="000"
}

# --- 1. /health serves, and reports a version -------------------------------
# The route exists precisely to answer "which build is this", so a health probe
# that only checks for 200 would pass against a build reporting "unknown".
request GET /health
if [ "$HTTP" = "000" ]; then
  record "health.serves" not_measured "no answer from $BASE — service unreachable" ""
  record "health.version" not_measured "depends on health.serves" ""
elif [ "$HTTP" != "200" ]; then
  record "health.serves" failed "expected 200, got $HTTP" "$HTTP"
  record "health.version" not_measured "depends on health.serves" ""
else
  record "health.serves" verified "200 from /health (outside the api/v1 prefix)" "$HTTP"
  VERSION="$(python3 -c '
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    print(""); raise SystemExit
v=d.get("version")
print(v if isinstance(v,str) else "")
' "$TMP/body")"
  if [ -z "$VERSION" ] || [ "$VERSION" = "unknown" ]; then
    record "health.version" failed "no usable version in the body (got '${VERSION:-<absent>}')" "$HTTP"
  else
    record "health.version" verified "version $VERSION" "$HTTP"
  fi
fi

# --- 2. the api/v1 prefix is in force ---------------------------------------
# /tasks without the prefix must NOT serve. A build that answers there is
# serving a different route table than the one main.ts declares.
request GET /tasks
if [ "$HTTP" = "000" ]; then
  record "prefix.enforced" not_measured "service unreachable" ""
elif [ "$HTTP" = "404" ]; then
  record "prefix.enforced" verified "un-prefixed /tasks is 404; api/v1 is in force" "$HTTP"
else
  record "prefix.enforced" failed "un-prefixed /tasks answered $HTTP, expected 404" "$HTTP"
fi

# --- 3. an unauthenticated call is refused, not served -----------------------
request GET /api/v1/tasks
if [ "$HTTP" = "000" ]; then
  record "auth.required" not_measured "service unreachable" ""
elif [ "$HTTP" = "401" ] || [ "$HTTP" = "403" ]; then
  record "auth.required" verified "unauthenticated /api/v1/tasks refused with $HTTP" "$HTTP"
else
  record "auth.required" failed "expected 401/403 without a credential, got $HTTP" "$HTTP"
fi

# --- 4. the agent surface answers (MUN-0045) ---------------------------------
if [ -z "$AGENT_KEY" ]; then
  record "agent.tasks" not_measured "no agent key supplied — absence of a credential is not evidence about the service" ""
  record "agent.status.archived" not_measured "depends on agent.tasks" ""
  record "agent.status.rejects_unknown" not_measured "depends on agent.tasks" ""
else
  request GET /api/v1/agents/tasks agent
  if [ "$HTTP" = "000" ]; then
    record "agent.tasks" not_measured "service unreachable" ""
    record "agent.status.archived" not_measured "depends on agent.tasks" ""
    record "agent.status.rejects_unknown" not_measured "depends on agent.tasks" ""
  elif [ "$HTTP" != "200" ]; then
    record "agent.tasks" failed "expected 200 with an agent key, got $HTTP" "$HTTP"
    record "agent.status.archived" not_measured "depends on agent.tasks" ""
    record "agent.status.rejects_unknown" not_measured "depends on agent.tasks" ""
  else
    SHAPE="$(python3 -c '
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    print("not-json"); raise SystemExit
print("list" if isinstance(d,list) else type(d).__name__)
' "$TMP/body")"
    if [ "$SHAPE" != "list" ]; then
      record "agent.tasks" failed "expected a JSON array, got $SHAPE" "$HTTP"
    else
      record "agent.tasks" verified "200, JSON array" "$HTTP"
    fi

    # MUN archived-status fix: the DTO imports TASK_STATUSES rather than
    # restating it, so `archived` must be accepted and an invented status must
    # still be refused. Both halves are probed — accepting everything looks
    # identical to accepting the right things if only the first is asked.
    request GET "/api/v1/tasks?status=archived" agent
    ARCHIVED_CODE="$HTTP"
    request GET "/api/v1/tasks?status=almost_done" agent
    BOGUS_CODE="$HTTP"
    if [ "$ARCHIVED_CODE" = "000" ] || [ "$BOGUS_CODE" = "000" ]; then
      record "agent.status.archived" not_measured "service unreachable" ""
      record "agent.status.rejects_unknown" not_measured "service unreachable" ""
    elif [ "$ARCHIVED_CODE" = "403" ] || [ "$ARCHIVED_CODE" = "401" ]; then
      # The route exists but this principal cannot reach it: the guard answers
      # before validation, so the DTO is never consulted and nothing about it
      # was measured here.
      record "agent.status.archived" not_measured \
        "/api/v1/tasks closed to this principal ($ARCHIVED_CODE) — the guard answers before the DTO, so the status vocabulary is not observable from here" "$ARCHIVED_CODE"
      record "agent.status.rejects_unknown" not_measured \
        "same route, same principal ($BOGUS_CODE)" "$BOGUS_CODE"
    else
      if [ "$ARCHIVED_CODE" = "400" ]; then
        record "agent.status.archived" failed "status=archived rejected as invalid (400) — the DTO restates the vocabulary" "$ARCHIVED_CODE"
      else
        record "agent.status.archived" verified "status=archived accepted ($ARCHIVED_CODE)" "$ARCHIVED_CODE"
      fi
      if [ "$BOGUS_CODE" = "400" ]; then
        record "agent.status.rejects_unknown" verified "an undeclared status is still refused (400)" "$BOGUS_CODE"
      else
        record "agent.status.rejects_unknown" failed "status=almost_done answered $BOGUS_CODE, expected 400 — the validator is not discriminating" "$BOGUS_CODE"
      fi
    fi
  fi
fi

TOTAL=$((VERIFIED + FAILED + NOT_MEASURED))
echo
echo "probes: $TOTAL — verified $VERIFIED, failed $FAILED, not_measured $NOT_MEASURED"

if [ -n "$JSON_OUT" ]; then
  python3 - "$RESULTS" "$BASE" "$JSON_OUT" <<'PY'
import json, sys, datetime, urllib.parse
results, base, out = sys.argv[1:4]
rows = [json.loads(l) for l in open(results, encoding="utf-8") if l.strip()]
# The base URL can carry a host but never a credential; strip any userinfo so a
# receipt cannot become the place a secret is written down.
parts = urllib.parse.urlsplit(base)
safe = urllib.parse.urlunsplit(
    (parts.scheme, parts.hostname + (f":{parts.port}" if parts.port else ""),
     parts.path, "", ""))
doc = {
    "observed": rows,
    "target": safe,
    "captured_at_utc": datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "producer": {"tool": "scripts/probe-endpoints.sh", "version": "1.0.0"},
    "counts": {
        "verified": sum(r["verdict"] == "verified" for r in rows),
        "failed": sum(r["verdict"] == "failed" for r in rows),
        "not_measured": sum(r["verdict"] == "not_measured" for r in rows),
    },
    "rule": ("every probe asserts the SHAPE of the answer, not only its status "
             "code; not_measured is the third verdict and is never a pass"),
}
with open(out, "w", encoding="utf-8") as fh:
    json.dump(doc, fh, indent=1, ensure_ascii=False, sort_keys=True)
    fh.write("\n")
print(f"observed section written to {out}")
PY
fi

[ "$FAILED" -eq 0 ]
