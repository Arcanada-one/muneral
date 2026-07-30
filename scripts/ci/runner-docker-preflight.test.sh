#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
subject="${script_dir}/runner-docker-preflight.sh"
fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "${fixture_dir}"' EXIT

fake_home="${fixture_dir}/home"
fake_bin="${fixture_dir}/bin"
compose_file="${fixture_dir}/docker-compose.prod.yml"
expected_plugin="${fixture_dir}/docker-compose"

mkdir -p -- "${fake_home}/.docker/cli-plugins" "${fake_bin}"
printf '%s\n' 'services: {}' >"${compose_file}"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"${expected_plugin}"
chmod 0755 "${expected_plugin}"
ln -s "${expected_plugin}" "${fake_home}/.docker/cli-plugins/docker-compose"

# The single-quoted lines below are the literal body of the generated fake.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'case "$*" in' \
  '  "info") exit "${FAKE_DOCKER_INFO_RC:-0}" ;;' \
  '  "compose version") exit "${FAKE_DOCKER_COMPOSE_VERSION_RC:-0}" ;;' \
  '  "compose -f "*" config --quiet") exit "${FAKE_DOCKER_COMPOSE_CONFIG_RC:-0}" ;;' \
  '  *) printf "unexpected docker argv: %s\n" "$*" >&2; exit 90 ;;' \
  'esac' >"${fake_bin}/docker"
chmod 0755 "${fake_bin}/docker"

run_subject() {
  env \
    PATH="${fake_bin}:${PATH}" \
    RUNNER_PREFLIGHT_HOME="${fake_home}" \
    RUNNER_PREFLIGHT_COMPOSE_FILE="${compose_file}" \
    RUNNER_PREFLIGHT_EXPECTED_PLUGIN="${expected_plugin}" \
    RUNNER_PREFLIGHT_VAULT_ADDR=http://vault.internal:8200 \
    RUNNER_PREFLIGHT_TEST_MODE=1 \
    RUNNER_PREFLIGHT_EFFECTIVE_GROUPS="ci-runner docker" \
    "$@" \
    "${subject}"
}

expect_success() {
  local name="$1"
  shift
  if ! "$@" >"${fixture_dir}/${name}.out" 2>&1; then
    printf 'FAIL: %s unexpectedly failed\n' "${name}" >&2
    sed -n '1,120p' "${fixture_dir}/${name}.out" >&2
    return 1
  fi
  printf 'PASS: %s\n' "${name}"
}

expect_failure() {
  local name="$1"
  shift
  if "$@" >"${fixture_dir}/${name}.out" 2>&1; then
    printf 'FAIL: %s unexpectedly passed\n' "${name}" >&2
    sed -n '1,120p' "${fixture_dir}/${name}.out" >&2
    return 1
  fi
  printf 'PASS: %s\n' "${name}"
}

expect_success happy_path run_subject

rm -- "${fake_home}/.docker/cli-plugins/docker-compose"
expect_failure missing_plugin run_subject
ln -s "${expected_plugin}" "${fake_home}/.docker/cli-plugins/docker-compose"

wrong_plugin="${fixture_dir}/wrong-compose"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"${wrong_plugin}"
chmod 0755 "${wrong_plugin}"
ln -sfn "${wrong_plugin}" "${fake_home}/.docker/cli-plugins/docker-compose"
expect_failure wrong_plugin_target run_subject
ln -sfn "${expected_plugin}" "${fake_home}/.docker/cli-plugins/docker-compose"

expect_failure docker_socket_unusable run_subject FAKE_DOCKER_INFO_RC=1
expect_failure compose_plugin_unusable run_subject FAKE_DOCKER_COMPOSE_VERSION_RC=1
expect_failure compose_config_invalid run_subject FAKE_DOCKER_COMPOSE_CONFIG_RC=1
expect_failure docker_group_missing run_subject RUNNER_PREFLIGHT_EFFECTIVE_GROUPS=ci-runner

expect_failure missing_vault_address run_subject RUNNER_PREFLIGHT_VAULT_ADDR=
expect_failure malformed_vault_address \
  run_subject RUNNER_PREFLIGHT_VAULT_ADDR=vault.internal:8200
expect_failure credentialed_vault_address \
  run_subject RUNNER_PREFLIGHT_VAULT_ADDR=http://user:password@vault.internal:8200
expect_success configured_vault_address \
  run_subject RUNNER_PREFLIGHT_VAULT_ADDR=http://vault.internal:8200

printf 'All runner Docker/Compose preflight regression cases passed.\n'
