#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
validator="${script_dir}/semantic-readback-caller-contract.sh"
fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "${fixture_dir}"' EXIT

write_fixture() {
  cat >"${fixture_dir}/workflow.yml" <<'YAML'
jobs:
  deploy:
    steps:
      - name: Wait for healthy
        run: curl -fsS http://localhost:3500/health
      - name: Semantic aggregate readback
        if: steps.preflight.outputs.status != 'fail'
        run: sudo -n /usr/local/sbin/arcanada-compose-broker muneral aggregate-readback
      - name: Status snapshot
        run: sudo -n /usr/local/sbin/arcanada-compose-broker muneral ps
YAML
}

expect_pass() {
  local name="$1"
  if ! SEMANTIC_READBACK_WORKFLOW="${fixture_dir}/workflow.yml" "$validator" \
      >"${fixture_dir}/${name}.out" 2>&1; then
    echo "FAIL: ${name} unexpectedly failed" >&2
    sed -n '1,80p' "${fixture_dir}/${name}.out" >&2
    exit 1
  fi
  echo "PASS: ${name}"
}

expect_fail() {
  local name="$1"
  if SEMANTIC_READBACK_WORKFLOW="${fixture_dir}/workflow.yml" "$validator" \
      >"${fixture_dir}/${name}.out" 2>&1; then
    echo "FAIL: ${name} unexpectedly passed" >&2
    exit 1
  fi
  echo "PASS: ${name}"
}

write_fixture
expect_pass fixed_zero_argument_caller

write_fixture
sed -i 's/ aggregate-readback$/ aggregate-readback SELECT-1/' "${fixture_dir}/workflow.yml"
expect_fail caller_supplied_sql

write_fixture
sed -i "/if: steps.preflight.outputs.status != 'fail'/d" "${fixture_dir}/workflow.yml"
expect_fail missing_preflight_gate

write_fixture
# The fixture must contain a literal DATABASE_URL reference.
# shellcheck disable=SC2016
sed -i 's#sudo -n /usr/local/sbin/arcanada-compose-broker muneral aggregate-readback#psql "$DATABASE_URL" -c SELECT-1#' "${fixture_dir}/workflow.yml"
expect_fail direct_database_bypass

write_fixture
sed -i "/if: steps.preflight.outputs.status != 'fail'/a\\        env:\n          DATABASE_URL: secret" "${fixture_dir}/workflow.yml"
expect_fail caller_receives_database_url

echo 'All semantic readback caller contract cases passed.'
