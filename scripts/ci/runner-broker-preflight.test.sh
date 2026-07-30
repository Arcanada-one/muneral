#!/usr/bin/env bash
# Mutation tests for runner-broker-preflight.sh: every guard is made to fire.
# A gate that has only ever been observed passing is not a gate.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
subject="${script_dir}/runner-broker-preflight.sh"
fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "${fixture_dir}"' EXIT

marker="${fixture_dir}/docker-group-retired"
absent="${fixture_dir}/no-such-broker"

# A real root-owned 0755 binary standing in for an installed broker. Using a
# fixture we created ourselves cannot exercise the root-ownership guard,
# because a file this account owns trips the writability guard first — that is
# the correct order, and the ownership guard is left covered only by the real
# install. Noted rather than papered over.
root_owned_broker=/usr/bin/true
[[ "$(stat -c '%U %a' -- "${root_owned_broker}")" == 'root 755' ]] ||
  { printf 'SKIP-UNSAFE: %s is not root-owned 0755 on this host\n' "${root_owned_broker}" >&2; exit 1; }

self_owned_broker="${fixture_dir}/self-owned-broker"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"${self_owned_broker}"
chmod 0755 "${self_owned_broker}"

not_executable="${fixture_dir}/not-executable-broker"
printf '%s\n' 'placeholder' >"${not_executable}"
chmod 0644 "${not_executable}"

symlinked="${fixture_dir}/symlinked-broker"
ln -s "${root_owned_broker}" "${symlinked}"

wrong_mode=/usr/bin/sudo
have_wrong_mode=0
if [[ -e "${wrong_mode}" && "$(stat -c '%U' -- "${wrong_mode}")" == 'root' &&
      "$(stat -c '%a' -- "${wrong_mode}")" != '755' ]]; then
  have_wrong_mode=1
fi

run_subject() {
  env \
    BROKER_PREFLIGHT_TEST_MODE=1 \
    BROKER_PREFLIGHT_BIN="${root_owned_broker}" \
    BROKER_PREFLIGHT_SERVICE=muneral \
    BROKER_PREFLIGHT_RETIRED_MARKER="${marker}" \
    BROKER_PREFLIGHT_EFFECTIVE_GROUPS="ci-runner" \
    "$@" \
    "${subject}"
}

expect_success() {
  local name="$1"; shift
  if ! "$@" >"${fixture_dir}/${name}.out" 2>&1; then
    printf 'FAIL: %s unexpectedly failed\n' "${name}" >&2
    sed -n '1,60p' "${fixture_dir}/${name}.out" >&2
    return 1
  fi
  printf 'PASS: %s\n' "${name}"
}

expect_failure() {
  local name="$1"; shift
  if "$@" >"${fixture_dir}/${name}.out" 2>&1; then
    printf 'FAIL: %s unexpectedly passed\n' "${name}" >&2
    sed -n '1,60p' "${fixture_dir}/${name}.out" >&2
    return 1
  fi
  printf 'PASS: %s\n' "${name}"
}

expect_success happy_path_before_group_retired run_subject

expect_failure broker_absent run_subject BROKER_PREFLIGHT_BIN="${absent}"
expect_failure broker_is_symlink run_subject BROKER_PREFLIGHT_BIN="${symlinked}"
expect_failure broker_not_executable run_subject BROKER_PREFLIGHT_BIN="${not_executable}"
expect_failure broker_writable_by_runner run_subject BROKER_PREFLIGHT_BIN="${self_owned_broker}"

if [[ "${have_wrong_mode}" == '1' ]]; then
  expect_failure broker_wrong_mode run_subject BROKER_PREFLIGHT_BIN="${wrong_mode}"
else
  printf 'SKIP: broker_wrong_mode — no root-owned non-0755 fixture on this host\n'
fi

# The whole point of the marker: once the group is retired, still being in it
# must fail the deploy rather than quietly work.
: >"${marker}"
expect_failure still_in_docker_group_after_retirement \
  run_subject BROKER_PREFLIGHT_EFFECTIVE_GROUPS="ci-runner docker"
expect_success out_of_docker_group_after_retirement \
  run_subject BROKER_PREFLIGHT_EFFECTIVE_GROUPS="ci-runner"
rm -f -- "${marker}"

# Before the marker exists the same membership must NOT fail, or no service
# could ever be migrated across the transition.
expect_success in_docker_group_before_retirement \
  run_subject BROKER_PREFLIGHT_EFFECTIVE_GROUPS="ci-runner docker"

printf 'All runner broker preflight regression cases passed.\n'
