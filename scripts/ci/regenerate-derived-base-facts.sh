#!/usr/bin/env bash
# Safe parsers for regenerate-derived-artefacts.yml base-branch facts.
#
# Measured failure (muneral regenerate-derived-artefacts runs 44290158619 /
# 44283053078 inventory): under `set -o pipefail`, pipelines that close early
# (`grep -m1`, `head -1`) while a producer is still writing return exit 141
# (SIGPIPE). The check step "Every workflow_run listener…" failed with 141
# before printing `ci.yml calls itself`, on the exact line:
#   ci_name=$(git show … | grep -m1 '^name:' | sed …)
# Local reproduction: a large producer piped into `grep -m1` under pipefail
# exits 141; the same parse via this script exits 0.
#
# Contract: never put an early-closing consumer on a live producer pipe.
# Callers pass already-captured file paths (fixtures in tests; temp files from
# `git show` in the workflow). No moving git refs are read here.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  regenerate-derived-base-facts.sh ci-name <ci.yml path>
  regenerate-derived-base-facts.sh node-version <ci.yml path>
  regenerate-derived-base-facts.sh list-workflow-yaml <workflows-dir>
  regenerate-derived-base-facts.sh assert-workflow-run-names <ci.yml path> <workflows-dir>
EOF
  exit 2
}

ci_name_from_file() {
  local path=$1 line
  [[ -f "$path" ]] || { echo "missing ci.yml: $path" >&2; return 2; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      name:*)
        line=${line#name:}
        # trim leading whitespace only (YAML name values are simple tokens here)
        line=${line#"${line%%[![:space:]]*}"}
        printf '%s\n' "$line"
        return 0
        ;;
    esac
  done <"$path"
  echo "no top-level name: in $path" >&2
  return 1
}

node_version_from_file() {
  local path=$1 line
  [[ -f "$path" ]] || { echo "missing ci.yml: $path" >&2; return 2; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*node-version:[[:space:]]*([0-9][0-9.]*) ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}"
      return 0
    fi
  done <"$path"
  echo "no node-version: in $path" >&2
  return 1
}

list_workflow_yaml() {
  local dir=$1 entry
  [[ -d "$dir" ]] || { echo "missing workflows dir: $dir" >&2; return 2; }
  # Directory walk, not `git ls-tree | grep` under pipefail.
  shopt -s nullglob
  for entry in "$dir"/*.yml "$dir"/*.yaml; do
    [[ -f "$entry" ]] || continue
    printf '%s\n' "$entry"
  done
}

assert_workflow_run_names() {
  local ci_yml=$1 workflows_dir=$2
  local ci_name listed bad=0 f
  ci_name=$(ci_name_from_file "$ci_yml")
  echo "ci.yml calls itself: ${ci_name}"
  shopt -s nullglob
  for f in "$workflows_dir"/*.yml "$workflows_dir"/*.yaml; do
    [[ -f "$f" ]] || continue
    grep -q 'workflow_run:' "$f" || continue
    # KEY line only; comments mentioning workflows: must not match (historical bug).
    # awk exits after the first key — no second consumer closes a live pipe under
    # pipefail (the measured SIGPIPE class).
    listed=$(awk '
      /^  workflow_run:/ { in_wr=1; next }
      in_wr && /^  [a-zA-Z]/ { exit }
      in_wr && /^    workflows:/ { print; exit }
    ' "$f")
    [[ -n "$listed" ]] || continue
    case "$listed" in
      *"$ci_name"*) echo "ok   $(basename "$f"): ${listed# *}" ;;
      *)
        echo "::error title=regenerate-derived-artefacts::$(basename "$f") listens for ${listed# *} but ci.yml is named '${ci_name}' — workflow_run matches by name, so that listener never fires and never reports anything."
        bad=1
        ;;
    esac
  done
  [[ "$bad" -eq 0 ]]
}

main() {
  [[ $# -ge 1 ]] || usage
  local cmd=$1
  shift
  case "$cmd" in
    ci-name)
      [[ $# -eq 1 ]] || usage
      ci_name_from_file "$1"
      ;;
    node-version)
      [[ $# -eq 1 ]] || usage
      node_version_from_file "$1"
      ;;
    list-workflow-yaml)
      [[ $# -eq 1 ]] || usage
      list_workflow_yaml "$1"
      ;;
    assert-workflow-run-names)
      [[ $# -eq 2 ]] || usage
      assert_workflow_run_names "$1" "$2"
      ;;
    *)
      usage
      ;;
  esac
}

main "$@"
