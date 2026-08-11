#!/usr/bin/env bash
# Fail closed unless the production workflow reaches Muneral semantic readback
# through the reviewed, zero-argument root broker verb. The caller must never
# receive SQL, a database URL, a container command, or a free-form parameter.
set -euo pipefail

fail() {
  printf 'semantic-readback-caller-contract: ERROR: %s\n' "$1" >&2
  exit 1
}

workflow="${SEMANTIC_READBACK_WORKFLOW:-.github/workflows/ci.yml}"
[[ -f "$workflow" && ! -L "$workflow" ]] || fail "workflow missing or not a regular file: $workflow"

name_count="$(grep -cE '^[[:space:]]+- name: Semantic aggregate readback[[:space:]]*$' "$workflow" || true)"
[[ "$name_count" == '1' ]] || fail "expected exactly one semantic readback step, found $name_count"

block="$(awk '
  found && /^[[:space:]]+- name:/ { exit }
  /^[[:space:]]+- name: Semantic aggregate readback[[:space:]]*$/ { found=1 }
  found { print }
' "$workflow")"

expected_run='        run: sudo -n /usr/local/sbin/arcanada-compose-broker muneral aggregate-readback'
run_count="$(printf '%s\n' "$block" | grep -Fxc "$expected_run" || true)"
[[ "$run_count" == '1' ]] || fail 'semantic readback must use the exact zero-argument broker command'

gate_count="$(printf '%s\n' "$block" | grep -Fxc "        if: steps.preflight.outputs.status != 'fail'" || true)"
[[ "$gate_count" == '1' ]] || fail 'semantic readback must retain the preflight fail gate'

if printf '%s\n' "$block" | grep -Eq 'DATABASE_URL|(^|[[:space:]])psql([[:space:]]|$)|docker[[:space:]]+exec|\$\{\{|^[[:space:]]+(env|with):'; then
  fail 'semantic readback caller contains a credential, SQL, container, expression, env, or free-form input surface'
fi

verb_count="$(grep -cF 'muneral aggregate-readback' "$workflow" || true)"
[[ "$verb_count" == '1' ]] || fail "expected one broker aggregate-readback invocation, found $verb_count"

echo 'semantic-readback-caller-contract: PASS fixed zero-argument broker caller'
