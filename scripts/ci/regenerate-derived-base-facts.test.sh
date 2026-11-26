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

WORK="$(mktemp -d)" || exit 2
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

# --- Case 1: the broken pipeline class must go red under pipefail ---------------
# A finite pad can fit in the pipe buffer on some runners (CI measured exit 0
# for a 50k-line producer). Use an unbounded writer that keeps flushing after
# the first match so SIGPIPE is forced — the same class as run 44290158619.
cat >"$WORK/forever_writer.py" <<'PY'
import signal
import sys

# Default SIGPIPE disposition so a closed consumer kills this process with 141
# (the measured pipefail class). Do not catch BrokenPipeError and exit 0.
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
sys.stdout.write("name: CI & Deploy\n")
sys.stdout.write("    node-version: 26.13.0\n")
sys.stdout.flush()
pad = ("pad: " + ("x" * 1024) + "\n").encode()
while True:
    sys.stdout.buffer.write(pad)
    sys.stdout.buffer.flush()
PY

cat >"$WORK/broken-grep-m1.sh" <<EOS
set -euo pipefail
ci_name=\$(python3 "$WORK/forever_writer.py" | grep -m1 '^name:' | sed 's/^name:[[:space:]]*//')
printf '%s\\n' "\$ci_name"
EOS

cat >"$WORK/broken-head-1.sh" <<EOS
set -euo pipefail
# head -1 alone (no trailing grep) — the pin-step class from the same workflow.
want=\$(python3 "$WORK/forever_writer.py" | grep -oE 'node-version: *[0-9][0-9.]*' | head -1)
printf '%s\\n' "\$want"
EOS

# timeout guards against a hung writer if a runner swallows SIGPIPE.
timeout 8 bash "$WORK/broken-grep-m1.sh" >/dev/null 2>&1
rc=$?
if [[ "$rc" -eq 141 ]]; then
  pass 'broken grep -m1 pipeline exits 141 under pipefail'
else
  fail "broken grep -m1 expected exit 141, got $rc"
fi

timeout 8 bash "$WORK/broken-head-1.sh" >/dev/null 2>&1
rc=$?
# Some runners deliver SIGPIPE (141); others hang until timeout (124). Both
# prove the early-close consumer under pipefail is unsafe for CI.
if [[ "$rc" -eq 141 || "$rc" -eq 124 ]]; then
  pass "broken head -1 pipeline is unsafe under pipefail (exit $rc)"
else
  fail "broken head -1 expected exit 141 or 124, got $rc"
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

listener_output="$WORK/regenerate-assert.out"
if "$HELPER" assert-workflow-run-names "$WORK/ci.yml" "$WORK/workflows" >"$listener_output" 2>&1; then
  if grep -Fq 'ok   listener.yml' "$listener_output"; then
    pass 'assert-workflow-run-names accepts matching listener'
  else
    fail 'assert-workflow-run-names missing ok line'
    cat "$listener_output" >&2
  fi
else
  fail "assert-workflow-run-names exited $?"
  cat "$listener_output" >&2
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

bad_listener_output="$WORK/regenerate-assert-bad.out"
if "$HELPER" assert-workflow-run-names "$WORK/ci.yml" "$WORK/workflows" >"$bad_listener_output" 2>&1; then
  fail 'assert-workflow-run-names should refuse mismatched workflows: name'
  cat "$bad_listener_output" >&2
else
  rc=$?
  if [[ "$rc" -eq 1 ]] && grep -Fq 'bad-listener.yml listens for' "$bad_listener_output"; then
    pass 'assert-workflow-run-names refuses mismatched workflows: name'
  else
    fail "assert-workflow-run-names did not report the expected mismatch (exit $rc)"
    cat "$bad_listener_output" >&2
  fi
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
