#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# MUN-0020 disposable PostgreSQL harness.
# Creates a task-owned PostgreSQL container with a random host port, applies
# all committed migrations, runs contract proofs, and removes every trace on
# exit. Accepts no secrets, prints no credentials, exposes no fixed port.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PRISMA_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

CONTAINER_NAME="mun0020_smoke_${$}_$(date +%s)"
PG_PORT="$(( 20000 + RANDOM % 30000 ))"
PG_USER="postgres"
PG_DB="mun0020_smoke"
created_container=0

cleanup() {
  set +e
  if [[ "$created_container" -eq 1 ]]; then
    sudo -n docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1
  fi
  set -e
}

verify_no_residue() {
  if sudo -n docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qxF "$CONTAINER_NAME"; then
    echo "container residue remains after cleanup: $CONTAINER_NAME" >&2
    return 1
  fi
}

on_exit() {
  local status="$?"
  trap - EXIT
  cleanup
  if ! verify_no_residue; then
    status=1
  fi
  exit "$status"
}
trap on_exit EXIT

# ---- Spin up disposable PostgreSQL ----
sudo -n docker run -d --rm \
  --name "$CONTAINER_NAME" \
  -p "127.0.0.1:${PG_PORT}:5432" \
  -e POSTGRES_PASSWORD=smoke_no_secret \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_DB="$PG_DB" \
  postgres:18 \
  >/dev/null
created_container=1

# ---- Wait for the final PostgreSQL server, not the temporary init server ----
# The official image briefly accepts connections while initializing, then
# shuts that temporary server down before starting the final postmaster.
for i in $(seq 1 30); do
  if sudo -n docker logs "$CONTAINER_NAME" 2>&1 |
       grep -qF 'PostgreSQL init process complete; ready for start up.' &&
     sudo -n docker exec "$CONTAINER_NAME" \
       pg_isready -U "$PG_USER" -d "$PG_DB" -q 2>/dev/null; then
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    echo "PostgreSQL did not become ready within 30s" >&2
    exit 1
  fi
  sleep 1
done
echo 'MUNERAL_EXEC_AUTH_PHASE_FINAL_POSTGRES_READY'

pg_psql() {
  sudo -n docker exec -i "$CONTAINER_NAME" \
    psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -At "$@"
}

pg_url="postgresql://${PG_USER}:smoke_no_secret@127.0.0.1:${PG_PORT}/${PG_DB}"
export MUN0020_DB_URL="$pg_url"

# ---- Apply all committed migrations in order ----
pg_psql -f - < "$PRISMA_DIR/migrations/20260607103126_init_schema/migration.sql" >/dev/null
echo 'MUNERAL_EXEC_AUTH_PHASE_INIT_SCHEMA_APPLIED'
pg_psql -f - < "$PRISMA_DIR/migrations/20260607200000_add_field_tracking/migration.sql" >/dev/null
echo 'MUNERAL_EXEC_AUTH_PHASE_FIELD_TRACKING_APPLIED'
pg_psql -f - < "$PRISMA_DIR/migrations/20260715170000_add_muneral_kb_task_changes/migration.sql" >/dev/null
echo 'MUNERAL_EXEC_AUTH_PHASE_KB_REGISTRY_APPLIED'
pg_psql -f - < "$PRISMA_DIR/migrations/20260730000000_add_execution_authority/migration.sql" >/dev/null
echo 'MUNERAL_EXEC_AUTH_PHASE_EXECUTION_AUTHORITY_APPLIED'

# ---- Preseed minimal workspace/project/task rows ----
pg_psql -f - < "$SCRIPT_DIR/execution_authority_preseed.sql" >/dev/null
echo 'MUNERAL_EXEC_AUTH_PHASE_PRESEED_APPLIED'

# ---- Run contract proofs ----
smoke_status=0
smoke_output="$(pg_psql -f - < "$SCRIPT_DIR/execution_authority_smoke.sql" 2>&1)" ||
  smoke_status="$?"
if [[ "$smoke_status" -ne 0 ]]; then
  echo "execution-authority SQL proofs failed (psql exit $smoke_status)" >&2
  echo "--- smoke output ---" >&2
  echo "$smoke_output" >&2
  exit "$smoke_status"
fi
echo 'MUNERAL_EXEC_AUTH_PHASE_SQL_PROOFS_EXECUTED'
if ! grep -qF 'MUNERAL_EXEC_AUTH_SMOKE_PASS' <<< "$smoke_output"; then
  echo 'execution-authority smoke did not emit its success marker' >&2
  echo "--- smoke output ---" >&2
  echo "$smoke_output" >&2
  exit 1
fi

# ---- Count individual proof passes ----
for proof_num in 1 2 3 4 5 6 7 8 9 10 11 12; do
  marker="MUNERAL_EXEC_AUTH_PROOF_${proof_num}_PASS"
  if ! grep -qF "$marker" <<< "$smoke_output"; then
    echo "Proof $proof_num did not pass" >&2
    exit 1
  fi
done

# ---- Rollback refusal proof (real rollback.sql execution) ----
# Single-row deterministic fingerprint: trigger + sorted index set + row counts.
fingerprint_sql()
{
  pg_psql -f - << 'ENDFP'
SELECT
  (SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                  WHERE tgname = 'task_execution_transitions_append_only'))::text
  || ' | ' ||
  (SELECT string_agg(indexname, ',' ORDER BY indexname)
   FROM pg_catalog.pg_indexes
   WHERE indexname IN ('idx_task_exec_attempts_task_id',
                       'idx_task_exec_transitions_task_id',
                       'idx_task_exec_transitions_attempt_id'))
  || ' | state=' || (SELECT count(*) FROM public.task_execution_state)::text
  || ' | attempts=' || (SELECT count(*) FROM public.task_execution_attempts)::text
  || ' | transitions=' || (SELECT count(*) FROM public.task_execution_transitions)::text
  AS fingerprint;
ENDFP
}

pre_fp="$(fingerprint_sql 2>&1)"

# Assert the expected index set exists before rollback
if ! grep -qF 'idx_task_exec_attempts_task_id,idx_task_exec_transitions_attempt_id,idx_task_exec_transitions_task_id' <<< "$pre_fp"; then
  echo "pre-rollback fingerprint missing expected index set: $pre_fp" >&2
  exit 1
fi
if ! grep -qF 'true' <<< "$pre_fp"; then
  echo "pre-rollback fingerprint: append-only trigger not present: $pre_fp" >&2
  exit 1
fi

# Run rollback.sql — MUST fail
rollback_status=0
pg_psql -f - < "$PRISMA_DIR/migrations/20260730000000_add_execution_authority/rollback.sql" >/dev/null 2>&1 || rollback_status="$?"
if [[ "$rollback_status" -eq 0 ]]; then
  echo 'rollback.sql unexpectedly succeeded' >&2
  exit 1
fi

# Post-rollback fingerprint must be byte-identical
post_fp="$(fingerprint_sql 2>&1)"
if [[ "$pre_fp" != "$post_fp" ]]; then
  echo 'rollback.sql weakened schema: fingerprint mismatch' >&2
  echo "pre:  $pre_fp" >&2
  echo "post: $post_fp" >&2
  exit 1
fi
echo 'MUNERAL_EXEC_AUTH_ROLLBACK_PROOF_PASS'

# ---- Service-path integration tests (ExecutionAuthorityService via PrismaPg) ----
# Verify TCP connectivity via docker exec before spawning Jest
for i in $(seq 1 10); do
  if sudo -n docker exec "$CONTAINER_NAME" \
       pg_isready -U "$PG_USER" -d "$PG_DB" -q 2>/dev/null; then
    break
  fi
  if [[ "$i" -eq 10 ]]; then
    echo "PostgreSQL not ready in container after 10 attempts" >&2
    exit 1
  fi
  sleep 1
done
service_output="$(cd "$PRISMA_DIR/.." && MUN0020_DB_URL="$pg_url" npx jest --testPathPattern='execution-authority.service-smoke' --no-coverage --forceExit 2>&1)"
if ! grep -qE 'Tests:\s+15 passed,\s+15 total' <<< "$service_output"; then
  echo 'service-path integration smoke: expected exactly 15 passed, 15 total' >&2
  echo "--- service output ---" >&2
  echo "$service_output" >&2
  exit 1
fi

# ---- Verify task-owned container is the only one touched ----
cleanup
verify_no_residue
trap - EXIT
echo 'MUNERAL_EXEC_AUTH_REAL_PG_SMOKE_PASS'
