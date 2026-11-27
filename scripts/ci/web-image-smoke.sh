#!/usr/bin/env bash
# Build apps/web/Dockerfile and require HTTP 200 for /login from the running container.
# Runs on shared self-hosted runners whose Docker daemon is not private to this job, so:
#   * image tag and container name are unique per run attempt (never muneral-web:latest);
#   * no port is published and the container has no network; the probe runs inside it;
#   * `cleanup` removes only that container and that tag. Nothing is pruned or pushed.
# Usage: web-image-smoke.sh run|cleanup   (needs WEB_SMOKE_ID, run from the repo root)
set -euo pipefail

: "${WEB_SMOKE_ID:?WEB_SMOKE_ID is required}"
[[ "$WEB_SMOKE_ID" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "invalid WEB_SMOKE_ID" >&2; exit 2; }
image="muneral-web-ci:${WEB_SMOKE_ID}"
name="muneral-web-ci-${WEB_SMOKE_ID}"
attempts="${WEB_SMOKE_ATTEMPTS:-60}"
delay="${WEB_SMOKE_DELAY:-2}"

# Prints the status code of GET /login without following redirects; fails if nothing answers.
probe='fetch("http://127.0.0.1:3501/login",{redirect:"manual",signal:AbortSignal.timeout(5000)}).then(r=>{console.log(r.status);process.exit(0)},()=>process.exit(1))'

case "${1:-}" in
  run)
    docker build --file apps/web/Dockerfile --tag "$image" .
    echo "web-image-smoke: image $(docker image inspect --format '{{.Id}}' "$image")"
    # A per-run value: nothing from the repository or the runner is passed in.
    secret="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    docker run --detach --name "$name" --network none \
      --cap-drop ALL --security-opt no-new-privileges --memory 1g --pids-limit 256 \
      --env NEXTAUTH_SECRET="$secret" --env AUTH_TRUST_HOST=true "$image" >/dev/null
    status=""
    for ((i = 1; i <= attempts; i++)); do
      if status="$(docker exec "$name" node -e "$probe")"; then
        break
      fi
      status=""
      if [[ "$(docker inspect --format '{{.State.Running}}' "$name")" != "true" ]]; then
        echo "web-image-smoke: container exited before answering" >&2
        break
      fi
      sleep "$delay"
    done
    if [[ "$status" != "200" ]]; then
      echo "web-image-smoke: FAIL GET /login status=${status:-no-response}" >&2
      docker logs --tail 80 "$name" >&2 || true
      exit 1
    fi
    echo "web-image-smoke: PASS GET /login status=200"
    ;;
  cleanup)
    docker rm --force "$name" >/dev/null 2>&1 || true
    docker image rm "$image" >/dev/null 2>&1 || true
    ;;
  *)
    echo "usage: $0 run|cleanup" >&2
    exit 2
    ;;
esac
