#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
subject="${script_dir}/opsbot-secret-gate.sh"
fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "${fixture_dir}"' EXIT

valid_key="opsbot_$(printf 'a%.0s' {1..43})"

expect_success() {
  local name="$1"
  shift
  if ! "$@" >"${fixture_dir}/${name}.out" 2>&1; then
    printf 'FAIL: %s unexpectedly failed\n' "${name}" >&2
    sed -n '1,80p' "${fixture_dir}/${name}.out" >&2
    return 1
  fi
  printf 'PASS: %s\n' "${name}"
}

expect_failure() {
  local name="$1"
  shift
  if "$@" >"${fixture_dir}/${name}.out" 2>&1; then
    printf 'FAIL: %s unexpectedly passed\n' "${name}" >&2
    sed -n '1,80p' "${fixture_dir}/${name}.out" >&2
    return 1
  fi
  printf 'PASS: %s\n' "${name}"
}

expect_success canonical_key env OPSBOT_API_KEY="${valid_key}" "${subject}"
expect_failure missing_key env -u OPSBOT_API_KEY "${subject}"
expect_failure empty_key env OPSBOT_API_KEY= "${subject}"
expect_failure wrong_prefix env OPSBOT_API_KEY="wrong_${valid_key#opsbot_}" "${subject}"
expect_failure short_key env OPSBOT_API_KEY="${valid_key%?}" "${subject}"
expect_failure invalid_character \
  env OPSBOT_API_KEY="${valid_key%?}!" "${subject}"
expect_failure embedded_whitespace \
  env OPSBOT_API_KEY="${valid_key%?} " "${subject}"

if grep -R -F -q -- "${valid_key}" "${fixture_dir}"; then
  printf 'FAIL: secret value was disclosed in captured output\n' >&2
  exit 1
fi

printf 'All Ops Bot secret-gate regression cases passed.\n'
