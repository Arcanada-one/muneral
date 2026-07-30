#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '::error::opsbot-secret-gate: %s Restore or rotate it through the approved Ops Bot agent-registration and GitHub secret workflow.\n' "$1" >&2
  exit 1
}

opsbot_key="${OPSBOT_API_KEY:-}"

[[ -n "${opsbot_key}" ]] ||
  fail "OPSBOT_API_KEY is missing or empty"

[[ "${opsbot_key}" =~ ^opsbot_[A-Za-z0-9_-]{43}$ ]] ||
  fail "OPSBOT_API_KEY does not match the canonical agent-key contract"

printf 'opsbot-secret-gate: presence and format checks passed\n'
