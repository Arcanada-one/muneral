#!/usr/bin/env bash
# Controls for web-image-smoke.sh against a stub `docker`: only a literal 200 passes.
set -euo pipefail
here="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
cat >"$work/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$STUB_LOG"
case "$1" in
  build) exit "${STUB_BUILD_RC:-0}" ;;
  image) echo "sha256:stub" ;;
  exec) [[ -n "${STUB_STATUS:-}" ]] || exit 1; echo "$STUB_STATUS" ;;
  inspect) echo "${STUB_RUNNING:-true}" ;;
esac
STUB
chmod +x "$work/docker"
failed=0

expect() { # <label> <expected rc> [VAR=value...]
  local label="$1" want="$2" rc=0
  shift 2
  : >"$work/log"
  env PATH="$work:$PATH" STUB_LOG="$work/log" WEB_SMOKE_ID=t-1 WEB_SMOKE_ATTEMPTS=3 WEB_SMOKE_DELAY=0 "$@" \
    bash "$here/web-image-smoke.sh" run >"$work/out" 2>&1 || rc=$?
  if [[ "$rc" == "$want" ]]; then
    echo "ok   $label (rc=$rc)"
  else
    echo "FAIL $label: rc=$rc want=$want"
    cat "$work/out"
    failed=1
  fi
}

check() { # <label> <command...>
  local label="$1"
  shift
  if "$@"; then echo "ok   $label"; else echo "FAIL $label"; failed=1; fi
}

expect "200 passes" 0 STUB_STATUS=200
check "no network and no published port" bash -c "grep -q '^run .*--network none' '$work/log' && ! grep -Eq '^run .*(--publish| -p )' '$work/log'"
check "never the production tag" bash -c "! grep -q 'muneral-web:latest' '$work/log'"
expect "307 fails" 1 STUB_STATUS=307
expect "500 fails" 1 STUB_STATUS=500
expect "no response fails" 1 STUB_STATUS=
check "bounded wait: 3 probes" test "$(grep -c '^exec ' "$work/log")" = 3
expect "exited container fails" 1 STUB_STATUS= STUB_RUNNING=false
check "stops probing an exited container" test "$(grep -c '^exec ' "$work/log")" = 1
expect "failed build fails" 1 STUB_BUILD_RC=1 STUB_STATUS=200
check "nothing runs after a failed build" bash -c "! grep -q '^run ' '$work/log'"

: >"$work/log"
env PATH="$work:$PATH" STUB_LOG="$work/log" WEB_SMOKE_ID=t-1 bash "$here/web-image-smoke.sh" cleanup
check "cleanup removes only this run's container and tag" \
  test "$(cat "$work/log")" = "$(printf 'rm --force muneral-web-ci-t-1\nimage rm muneral-web-ci:t-1')"

exit "$failed"
