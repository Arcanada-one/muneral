#!/usr/bin/env bash
# Regression for regenerate-derived-artefacts exit 141 (SIGPIPE) under pipefail.
#
# Evidence: run 44290158619 job regenerate-derived-artefacts failed with
# "Process completed with exit code 141" on the step that runs a pipeline of the
# form  ci_name=$(<blob producer> | grep -m1 '^name:' | sed …)  before printing
# "ci.yml calls itself". Locally a large producer into grep -m1 under
# `set -o pipefail` exits 141; the fixed helper must not.
#
# No moving git refs: producers and YAML are synthetic fixtures under this
# script's temp dir (plain byte files), never a live branch tip.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$HERE/regenerate-derived-base-facts.sh"
[[ -f "$HELPER" ]] || { echo "missing helper: $HELPER" >&2; exit 2; }
chmod +x "$HELPER"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

# --- Case 1: the broken pipeline class must go red under pipefail ---------------
# Amplify the producer so the writer outlives grep -m1 / head -1 (ci.yml on a
# quiet day can fit in the pipe buffer and hide the race — that is why the CI
# failure was intermittent).
cat >"$WORK/broken-grep-m1.sh" <<'EOS'
set -euo pipefail
producer() {
  printf 'name: CI & Deploy\n'
  # Enough trailing bytes that closing after the first match SIGPIPEs the writer.
  i=0
  while [ "$i" -lt 50000 ]; do
    printf 'pad-%s: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n' "$i"
    i=$((i + 1))
  done
}
ci_name=$(producer | grep -m1 '^name:' | sed 's/^name:[[:space:]]*//')
printf '%s\n' "$ci_name"
EOS

cat >"$WORK/broken-head-1.sh" <<'EOS'
set -euo pipefail
producer() {
  i=0
  while [ "$i" -lt 20000 ]; do
    printf '    node-version: 26.13.0\n'
    i=$((i + 1))
  done
}
want=$(producer | grep -oE 'node-version: *[0-9][0-9.]*' | head -1 | grep -oE '[0-9][0-9.]*')
printf '%s\n' "$want"
EOS

bash "$WORK/broken-grep-m1.sh" >/dev/null 2>&1
rc=$?
if [[ "$rc" -eq 141 ]]; then
  pass 'broken grep -m1 pipeline exits 141 under pipefail'
else
  fail "broken grep -m1 expected exit 141, got $rc"
fi

bash "$WORK/broken-head-1.sh" >/dev/null 2>&1
rc=$?
if [[ "$rc" -eq 141 ]]; then
  pass 'broken head -1 pipeline exits 141 under pipefail'
else
  fail "broken head -1 expected exit 141, got $rc"
fi

# --- Case 2: fixed helper parses a committed fixture without SIGPIPE ------------
# Fixture is a large synthetic ci.yml (not a git ref): name + many pads + a
# node-version later in the file, matching the shape that tripped production.
{
  printf 'name: CI & Deploy\n'
  i=0
  while [ "$i" -lt 50000 ]; do
    printf 'pad-%s: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n' "$i"
    i=$((i + 1))
  done
  printf '    node-version: 26.13.0\n'
} >"$WORK/ci.yml"

name="$("$HELPER" ci-name "$WORK/ci.yml")"
rc=$?
if [[ "$rc" -eq 0 && "$name" == 'CI & Deploy' ]]; then
  pass "helper ci-name => '$name'"
else
  fail "helper ci-name rc=$rc name='$name'"
fi

ver="$("$HELPER" node-version "$WORK/ci.yml")"
rc=$?
if [[ "$rc" -eq 0 && "$ver" == '26.13.0' ]]; then
  pass "helper node-version => '$ver'"
else
  fail "helper node-version rc=$rc ver='$ver'"
fi

# --- Case 3: workflow_run name assertion on fixtures (no git) -------------------
mkdir -p "$WORK/workflows"
cat >"$WORK/workflows/listener.yml" <<'EOF'
name: listener
on:
  workflow_run:
    workflows: ['CI & Deploy']
    types: [completed]
jobs:
  j:
    runs-on: [self-hosted, linux, ci-general]
    steps:
      - run: 'true'
EOF

# Comment trap: a comment containing the word workflows: must not be treated as the key.
cat >"$WORK/workflows/comment-only.yml" <<'EOF'
name: comment-only
# workflows: ['Wrong Name']
on:
  push:
jobs:
  j:
    runs-on: [self-hosted, linux, ci-general]
    steps:
      - run: 'true'
EOF

if "$HELPER" assert-workflow-run-names "$WORK/ci.yml" "$WORK/workflows" >/tmp/regenerate-assert.out 2>&1; then
  if grep -q 'ok   listener.yml' /tmp/regenerate-assert.out; then
    pass 'assert-workflow-run-names accepts matching listener'
  else
    fail 'assert-workflow-run-names missing ok line'
    cat /tmp/regenerate-assert.out >&2
  fi
else
  fail "assert-workflow-run-names exited $?"
  cat /tmp/regenerate-assert.out >&2
fi

# Mismatch must go red.
cat >"$WORK/workflows/bad-listener.yml" <<'EOF'
name: bad-listener
on:
  workflow_run:
    workflows: ['ci']
    types: [completed]
jobs:
  j:
    runs-on: [self-hosted, linux, ci-general]
    steps:
      - run: 'true'
EOF

if "$HELPER" assert-workflow-run-names "$WORK/ci.yml" "$WORK/workflows" >/tmp/regenerate-assert-bad.out 2>&1; then
  fail 'assert-workflow-run-names should refuse mismatched workflows: name'
  cat /tmp/regenerate-assert-bad.out >&2
else
  pass 'assert-workflow-run-names refuses mismatched workflows: name'
fi

# --- Case 4: workflow file must not reintroduce the measured SIGPIPE pipes ------
WORKFLOW="$HERE/../../.github/workflows/regenerate-derived-artefacts.yml"
if [[ ! -f "$WORKFLOW" ]]; then
  fail "workflow missing at $WORKFLOW"
else
  if grep -nE 'grep -m1 '\''\^name:'\|'head -1 \| grep -oE' "$WORKFLOW"; then
    fail 'workflow still contains measured SIGPIPE pipelines (grep -m1 /^name:/ or head -1 | grep -oE)'
  else
    pass 'workflow no longer embeds measured SIGPIPE pipelines'
  fi
  if grep -q 'regenerate-derived-base-facts.sh' "$WORKFLOW"; then
    pass 'workflow calls regenerate-derived-base-facts.sh'
  else
    fail 'workflow does not call regenerate-derived-base-facts.sh'
  fi
fi

if [[ "$FAILURES" -ne 0 ]]; then
  echo "$FAILURES failure(s)" >&2
  exit 1
fi
echo 'all regenerate-derived-base-facts contract checks passed'
exit 0
