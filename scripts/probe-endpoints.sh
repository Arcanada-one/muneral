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
#                              [--expect-commit SHA]
#
#   --base       default http://127.0.0.1:3500
#   --agent-key  a `mun_sk_` key; without it every agent-scoped probe is
#                not_measured rather than failed — absence of a credential is
#                not evidence about the service. Also readable from
#                MUNERAL_AGENT_KEY, which is how CI should pass it: the key is
#                never echoed, never written to the JSON, and never logged.
#   --json       write the observed section here (default: stdout only)
#   --expect-commit  the 40-hex commit this instance is supposed to be built
#                from (a deploy passes $GITHUB_SHA). With it, `health.commit`
#                is a GATE: a different commit, or a service that cannot name
#                its commit at all, is `failed`. Without it the probe asserts
#                only the SHAPE of the field, and a service reporting
#                `build.sha: null` WITH a reason is not_measured — a
#                hand-started development instance is expected to land there.
#
# Exit: 0 when no probe failed, 1 when any did. `not_measured` does not fail the
# run — it is reported, and a receipt carrying one is a receipt that says so.
set -uo pipefail

BASE="http://127.0.0.1:3500"
AGENT_KEY="${MUNERAL_AGENT_KEY:-}"
JSON_OUT=""
EXPECT_COMMIT=""
UA="aup-orchestrator/1.0"

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --agent-key) AGENT_KEY="$2"; shift 2 ;;
    --json) JSON_OUT="$2"; shift 2 ;;
    --expect-commit) EXPECT_COMMIT="$2"; shift 2 ;;
    -h|--help) sed -n '2,41p' "$0"; exit 0 ;;
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

# --- 1. /health serves, names a release, and names a commit ------------------
# The route exists precisely to answer "which build is this", so a health probe
# that only checks for 200 would pass against a build that cannot say. Both
# halves of that identity are asserted here, and each is judged on its own:
#
#   health.version  the RELEASE, read from apps/api/package.json. The check
#                   refuses the controller's own sentinel `0.0.0-unknown`
#                   (apps/api/src/health.controller.ts) and anything not shaped
#                   like a release. A2-251 measured the earlier check comparing
#                   against the string "unknown" instead, so the sentinel passed
#                   as a valid version: a probe that cannot go red where it is
#                   supposed to is worse than no probe, because it is counted.
#   health.commit   the COMMIT, read from build.sha (apps/api/src/build-info.ts).
#                   A version cannot answer this — the manifest has said 0.4.6
#                   since 6c9b48e, the same string for every commit after it.
#
# Each verdict comes back from python as two lines (verdict, then detail) so the
# rules live in one place and the shell only records what was decided.
verdict_of() { printf '%s' "$1" | head -1; }
detail_of() { printf '%s' "$1" | tail -n +2 | tr '\n' ' '; }

request GET /health
if [ "$HTTP" = "000" ]; then
  record "health.serves" not_measured "no answer from $BASE — service unreachable" ""
  record "health.version" not_measured "depends on health.serves" ""
  record "health.commit" not_measured "depends on health.serves" ""
elif [ "$HTTP" != "200" ]; then
  record "health.serves" failed "expected 200, got $HTTP" "$HTTP"
  record "health.version" not_measured "depends on health.serves" ""
  record "health.commit" not_measured "depends on health.serves" ""
else
  record "health.serves" verified "200 from /health (outside the api/v1 prefix)" "$HTTP"

  VERSION_ROW="$(python3 -c '
import json, re, sys

SENTINEL = "0.0.0-unknown"   # apps/api/src/health.controller.ts, unresolvable manifest
RELEASE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+([-+].*)?$")

try:
    body = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    print("failed"); print("/health did not return JSON, so it named no version"); raise SystemExit
v = body.get("version") if isinstance(body, dict) else None
if not isinstance(v, str) or v.strip() == "":
    print("failed"); print("no usable version in the body (got %r)" % (v,))
elif v == SENTINEL:
    print("failed")
    print("version is the controller sentinel " + SENTINEL + " — this build cannot resolve its "
          "own manifest, so it reported no release; that is not a release number")
elif not RELEASE.match(v):
    print("failed"); print("version %r is not shaped like a release (major.minor.patch)" % (v,))
else:
    print("verified"); print("version " + v)
' "$TMP/body")"
  record "health.version" "$(verdict_of "$VERSION_ROW")" "$(detail_of "$VERSION_ROW")" "$HTTP"

  COMMIT_ROW="$(python3 -c '
import json, re, sys

SHA40 = re.compile(r"^[0-9a-f]{40}$", re.I)
expect = sys.argv[2].strip().lower()

try:
    body = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    print("failed"); print("/health did not return JSON, so it named no commit"); raise SystemExit
build = body.get("build") if isinstance(body, dict) else None
if not isinstance(build, dict):
    print("failed")
    print("/health carries no `build` object, so this process cannot name the commit it was "
          "built from and no measurement taken through it can be attributed to one")
    raise SystemExit
sha = build.get("sha")
problem = build.get("problem")
if isinstance(sha, str) and SHA40.match(sha):
    got = sha.lower()
    if expect and got != expect:
        print("failed")
        print("build.sha is " + got + ", expected " + expect + " — the process answering is not "
              "built from the commit this run deployed")
    elif expect:
        print("verified"); print("build.sha " + got + " is the expected commit")
    else:
        print("verified"); print("build.sha " + got + " is a full 40-hex commit id")
elif isinstance(sha, str):
    print("failed")
    print("build.sha %r is not a full 40-hex commit id (%d chars)" % (sha, len(sha)))
elif sha is None:
    detail = problem if isinstance(problem, str) and problem else "and gives no reason"
    if expect:
        print("failed")
        print("build.sha is null while commit " + expect + " was expected — the deploy claimed a "
              "commit the running service cannot confirm: " + detail)
    else:
        # The third verdict on purpose: a service that says it cannot name its build is
        # not a service answering wrongly. It is never a pass either.
        print("not_measured"); print("build.sha is null and says why: " + detail)
else:
    print("failed"); print("build.sha is %s, expected a string or null" % type(sha).__name__)
' "$TMP/body" "$EXPECT_COMMIT")"
  record "health.commit" "$(verdict_of "$COMMIT_ROW")" "$(detail_of "$COMMIT_ROW")" "$HTTP"
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
  record "agent.tasks.contract_digest" not_measured "depends on agent.tasks" ""
  record "agent.status.archived" not_measured "depends on agent.tasks" ""
  record "agent.status.rejects_unknown" not_measured "depends on agent.tasks" ""
else
  request GET /api/v1/agents/tasks agent
  if [ "$HTTP" = "000" ]; then
    record "agent.tasks" not_measured "service unreachable" ""
    record "agent.tasks.contract_digest" not_measured "depends on agent.tasks" ""
    record "agent.status.archived" not_measured "depends on agent.tasks" ""
    record "agent.status.rejects_unknown" not_measured "depends on agent.tasks" ""
  elif [ "$HTTP" != "200" ]; then
    record "agent.tasks" failed "expected 200 with an agent key, got $HTTP" "$HTTP"
    record "agent.tasks.contract_digest" not_measured "depends on agent.tasks" ""
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
      record "agent.tasks.contract_digest" not_measured "depends on agent.tasks" ""
    else
      record "agent.tasks" verified "200, JSON array" "$HTTP"

      # A2-267: every task this list returns carries `contractDigest` as a KEY —
      # null for a task not born from a KC2 contract, `sha256:<64 lowercase
      # hex>` for one that was. A build that predates the column omits the key,
      # and an executing agent reading `.get("contractDigest")` would take that
      # absence for "no contract": so an absent key is `failed`, never a gap.
      # An empty list shows nothing about the field and is the third verdict.
      DIGEST_ROW="$(python3 -c '
import json, re, sys

DIGEST = re.compile(r"sha256:[0-9a-f]{64}")   # CreateTaskDto CONTRACT_DIGEST_PATTERN, used with fullmatch
rows = json.load(open(sys.argv[1], encoding="utf-8"))
tasks = [r.get("task") for r in rows if isinstance(r, dict)]
if not tasks:
    print("not_measured")
    print("this agent is assigned no task, so no task row was observed to carry the field")
    raise SystemExit
missing = sum(1 for t in tasks if not isinstance(t, dict) or "contractDigest" not in t)
bad = [t["contractDigest"] for t in tasks if isinstance(t, dict) and t.get("contractDigest") is not None
       and not (isinstance(t["contractDigest"], str) and DIGEST.fullmatch(t["contractDigest"]))]
bound = sum(1 for t in tasks if isinstance(t, dict) and isinstance(t.get("contractDigest"), str))
if missing:
    print("failed")
    print("%d of %d task rows carry no contractDigest key — this build predates A2-267, and a "
          "reader would take the absence for a task with no contract" % (missing, len(tasks)))
elif bad:
    print("failed")
    print("%d contractDigest value(s) are not sha256:<64 lowercase hex>, first %r" % (len(bad), bad[0]))
else:
    print("verified")
    print("%d task rows carry the key; %d bound to a contract, %d null" % (len(tasks), bound, len(tasks) - bound))
' "$TMP/body")"
      record "agent.tasks.contract_digest" "$(verdict_of "$DIGEST_ROW")" "$(detail_of "$DIGEST_ROW")" "$HTTP"
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
