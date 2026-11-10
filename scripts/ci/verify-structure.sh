#!/usr/bin/env bash
# BATCH-004: lightweight repository structure check. Emits a machine report to
# stdout (caller redirects to reports/verify-structure.txt). Exit 0 only when
# every required path exists. BATCH-005 may replace this with a richer collector.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd -- "$ROOT"
required=(
  apps/api/package.json
  apps/web/package.json
  packages/types/package.json
  .github/workflows/ci.yml
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
)
missing=0
printf 'verify-structure: start root=%s\n' "$ROOT"
for path in "${required[@]}"; do
  if [[ -e "${path}" ]]; then
    printf 'OK %s\n' "${path}"
  else
    printf 'MISSING %s\n' "${path}"
    missing=1
  fi
done
if [[ "${missing}" -ne 0 ]]; then
  printf 'verify-structure: FAIL\n'
  exit 1
fi
printf 'verify-structure: PASS\n'
exit 0
