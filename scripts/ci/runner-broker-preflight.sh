#!/usr/bin/env bash
# SEC-0028 — assert this runner can deploy through the root broker, and that it
# is not doing so while still holding the escalation the broker exists to
# remove.
#
# This replaces runner-docker-preflight.sh, which asserted the opposite: that
# the runner *is* in the host `docker` group. Membership of that group is
# root-equivalent on a host that also carries the Control Arcana root deploy
# broker, so the old check was gating on the presence of the very thing being
# removed.
#
# The negative assertion is armed by a host marker rather than being
# unconditional, because the group cannot be dropped until every service that
# relied on it deploys through the broker — and proving those deploys requires
# running this check while the group is still present. Root creates the marker
# at the moment the group is dropped, so the strict check turns on exactly then
# and cannot be forgotten. The marker only ever becomes stricter.
set -euo pipefail

fail() {
  printf 'runner-broker-preflight: ERROR: %s\n' "$1" >&2
  exit 1
}

broker="${BROKER_PREFLIGHT_BIN:-/usr/local/sbin/arcanada-compose-broker}"
service="${BROKER_PREFLIGHT_SERVICE:-muneral}"
marker="${BROKER_PREFLIGHT_RETIRED_MARKER:-/etc/arcanada/docker-group-retired}"
forbidden_group="${BROKER_PREFLIGHT_FORBIDDEN_GROUP:-docker}"

[[ -f "${broker}" ]] || fail "deploy broker is not installed at ${broker}"
[[ ! -L "${broker}" ]] || fail "deploy broker path is a symlink"
[[ -x "${broker}" ]] || fail "deploy broker is not executable"

# The broker binds the runner; a runner that can rewrite it is not bound. The
# writability test comes first because it is the one that holds under an ACL,
# which a mode comparison silently misses — and this host does grant ACLs.
[[ ! -w "${broker}" ]] || fail "deploy broker is writable by this account"
owner="$(stat -c '%U' -- "${broker}")"
[[ "${owner}" == 'root' ]] || fail "deploy broker is owned by ${owner}, not root"
mode="$(stat -c '%a' -- "${broker}")"
[[ "${mode}" == '755' ]] || fail "deploy broker mode is ${mode}, expected 755"

if [[ "${BROKER_PREFLIGHT_TEST_MODE:-0}" == "1" ]]; then
  effective_groups="${BROKER_PREFLIGHT_EFFECTIVE_GROUPS:-}"
else
  effective_groups="$(id -nG)"
fi

if [[ -e "${marker}" ]]; then
  case " ${effective_groups} " in
    *" ${forbidden_group} "*)
      fail "runner is still in the ${forbidden_group} group after it was retired on this host"
      ;;
  esac
else
  printf 'runner-broker-preflight: NOTE: %s absent — %s group membership not yet retired on this host\n' \
    "${marker}" "${forbidden_group}"
fi

# Prove the sudo grant actually resolves, rather than assuming it. `ps` is the
# cheapest read-only action the broker exposes and touches the same allowlist,
# checkout and compose-file validation every other action does.
if [[ "${BROKER_PREFLIGHT_TEST_MODE:-0}" != "1" ]]; then
  sudo -n "${broker}" "${service}" ps >/dev/null ||
    fail "sudo -n ${broker} ${service} ps failed — broker grant or checkout is not usable"
fi

printf 'runner-broker-preflight: broker install, ownership, group state and sudo grant checks passed\n'
