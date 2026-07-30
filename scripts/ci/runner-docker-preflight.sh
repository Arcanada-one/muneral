#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'runner-preflight: ERROR: %s\n' "$1" >&2
  exit 1
}

runner_home="${RUNNER_PREFLIGHT_HOME:-${HOME:-}}"
compose_file="${RUNNER_PREFLIGHT_COMPOSE_FILE:-}"
expected_plugin="${RUNNER_PREFLIGHT_EXPECTED_PLUGIN:-}"
vault_addr="${RUNNER_PREFLIGHT_VAULT_ADDR:-}"
docker_bin="${RUNNER_PREFLIGHT_DOCKER_BIN:-docker}"
expected_group="${RUNNER_PREFLIGHT_EXPECTED_GROUP:-docker}"

[[ -n "${runner_home}" ]] || fail "runner home is not configured"
[[ -n "${compose_file}" ]] || fail "production Compose file is not configured"
[[ -r "${compose_file}" ]] || fail "production Compose file is not readable"
[[ -n "${expected_plugin}" ]] || fail "expected Compose plugin path is not configured"
[[ -x "${expected_plugin}" ]] || fail "expected Compose plugin is absent or not executable"
[[ -n "${vault_addr}" ]] || fail "VAULT_ADDR repository variable is missing or empty"

case "${vault_addr}" in
  http://* | https://*) ;;
  *) fail "VAULT_ADDR must use an http or https URL" ;;
esac

vault_authority="${vault_addr#*://}"
vault_authority="${vault_authority%%/*}"
[[ -n "${vault_authority}" ]] || fail "VAULT_ADDR has no authority component"
[[ "${vault_authority}" != *"@"* ]] || fail "VAULT_ADDR must not embed credentials"
[[ "${vault_authority}" != *[[:space:]]* ]] || fail "VAULT_ADDR contains whitespace"

plugin_link="${runner_home}/.docker/cli-plugins/docker-compose"
[[ -L "${plugin_link}" ]] || fail "per-user Compose plugin symlink is missing"

resolved_plugin="$(readlink -f -- "${plugin_link}")"
resolved_expected="$(readlink -f -- "${expected_plugin}")"
[[ "${resolved_plugin}" == "${resolved_expected}" ]] ||
  fail "per-user Compose plugin does not resolve to the provisioned target"

if [[ "${RUNNER_PREFLIGHT_TEST_MODE:-0}" == "1" ]]; then
  effective_groups="${RUNNER_PREFLIGHT_EFFECTIVE_GROUPS:-}"
else
  effective_groups="$(id -nG)"
fi

case " ${effective_groups} " in
  *" ${expected_group} "*) ;;
  *) fail "runner process is not a member of the required Docker group" ;;
esac

command -v -- "${docker_bin}" >/dev/null 2>&1 ||
  fail "Docker CLI is not available"
"${docker_bin}" info >/dev/null 2>&1 ||
  fail "Docker daemon/socket is not usable by the runner process"
"${docker_bin}" compose version >/dev/null 2>&1 ||
  fail "Docker Compose plugin is not executable by the runner process"
"${docker_bin}" compose -f "${compose_file}" config --quiet >/dev/null 2>&1 ||
  fail "production Compose configuration is invalid or unreadable"

printf 'runner-preflight: Docker, Compose, group, Vault endpoint, and Compose config checks passed\n'
