#!/usr/bin/env bash
set -euo pipefail

# Production-faithful destructive testing is confined to a disposable database
# on the explicitly supplied PostgreSQL host. Authentication is inherited from
# the caller's SSH agent; this harness accepts and emits no database secret.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PRISMA_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SSH_TARGET="${MUNERAL_SMOKE_SSH_TARGET:-}"
PG_CONTAINER="${MUNERAL_SMOKE_PG_CONTAINER:-arcana-postgres}"

if [[ -z "$SSH_TARGET" ]]; then
  echo 'MUNERAL_SMOKE_SSH_TARGET is required' >&2
  exit 2
fi
if [[ ! "$SSH_TARGET" =~ ^[A-Za-z0-9_.@:-]+$ ]]; then
  echo 'MUNERAL_SMOKE_SSH_TARGET contains unsupported characters' >&2
  exit 2
fi
if [[ ! "$PG_CONTAINER" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo 'MUNERAL_SMOKE_PG_CONTAINER contains unsupported characters' >&2
  exit 2
fi

suffix="${$}_$(date +%s)"
db="ltm0025_registry_smoke_${suffix}"
reader="ltm0025_reader_${suffix}"
created_db=0
created_reader=0

remote_psql_file() {
  local database="$1"
  local file="$2"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_TARGET" \
    "docker exec -i '$PG_CONTAINER' psql -U postgres -d '$database' -v ON_ERROR_STOP=1 -At" \
    < "$file"
}

remote_psql_query() {
  local database="$1"
  local sql="$2"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_TARGET" \
    "docker exec -i '$PG_CONTAINER' psql -U postgres -d '$database' -v ON_ERROR_STOP=1 -Atq" \
    <<< "$sql"
}

cleanup() {
  set +e
  if [[ "$created_db" -eq 1 ]]; then
    ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_TARGET" \
      "docker exec '$PG_CONTAINER' dropdb -U postgres --if-exists '$db'" \
      >/dev/null 2>&1
  fi
  if [[ "$created_reader" -eq 1 ]]; then
    ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_TARGET" \
      "docker exec '$PG_CONTAINER' psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'DROP ROLE IF EXISTS \"$reader\"'" \
      >/dev/null 2>&1
  fi
  set -e
}

verify_no_residue() {
  local residue
  residue="$(remote_psql_query postgres \
    "SELECT count(*) FROM pg_catalog.pg_database WHERE datname = '$db'; SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = '$reader';")"
  if [[ "$residue" != $'0\n0' ]]; then
    echo 'reader/database residue remains after smoke cleanup' >&2
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

ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_TARGET" \
  "docker exec '$PG_CONTAINER' createdb -U postgres '$db'"
created_db=1

remote_psql_file "$db" \
  "$PRISMA_DIR/migrations/20260607103126_init_schema/migration.sql" >/dev/null
remote_psql_file "$db" \
  "$PRISMA_DIR/migrations/20260607200000_add_field_tracking/migration.sql" >/dev/null
remote_psql_file "$db" \
  "$SCRIPT_DIR/muneral_kb_change_registry_preseed.sql" >/dev/null
remote_psql_file "$db" \
  "$PRISMA_DIR/migrations/20260715170000_add_muneral_kb_task_changes/migration.sql" >/dev/null

smoke_output="$(remote_psql_file "$db" \
  "$SCRIPT_DIR/muneral_kb_change_registry_smoke.sql")"
if [[ "$(tail -n 1 <<< "$smoke_output")" != 'MUNERAL_KB_CHANGE_REGISTRY_SMOKE_PASS' ]]; then
  echo 'registry behavior smoke did not emit its success marker' >&2
  exit 1
fi

remote_psql_file "$db" \
  "$SCRIPT_DIR/muneral_kb_change_registry_concurrency_setup.sql" >/dev/null

# Force concurrent project/dependency sessions across the same task rows. Both
# trigger paths sort UUIDs, so one session may wait but neither may deadlock.
set +e
remote_psql_query "$db" \
  "BEGIN;
   SET LOCAL application_name = 'ltm-project';
   SET LOCAL deadlock_timeout = '100ms';
   SET LOCAL lock_timeout = '8s';
   SET LOCAL statement_timeout = '12s';
   UPDATE public.projects
   SET name = 'concurrent project update'
   WHERE id = '30000000-0000-0000-0000-000000000001'::uuid;
   COMMIT;" >/dev/null &
project_pid="$!"
remote_psql_query "$db" \
  "BEGIN;
   SET LOCAL application_name = 'ltm-dependency';
   SET LOCAL deadlock_timeout = '100ms';
   SET LOCAL lock_timeout = '8s';
   SET LOCAL statement_timeout = '12s';
   UPDATE public.task_dependencies
   SET from_task_id = 'a0000000-0000-0000-0000-000000000001'::uuid,
       to_task_id = 'a0000000-0000-0000-0000-000000000002'::uuid
   WHERE id = 'd0000000-0000-0000-0000-000000000007'::uuid;
   COMMIT;" >/dev/null &
dependency_pid="$!"
wait "$project_pid"
project_status="$?"
wait "$dependency_pid"
dependency_status="$?"
set -e
if [[ "$project_status" -ne 0 || "$dependency_status" -ne 0 ]]; then
  echo 'concurrent project/dependency sessions did not both commit' >&2
  exit 1
fi

concurrency_output="$(remote_psql_file "$db" \
  "$SCRIPT_DIR/muneral_kb_change_registry_concurrency_assert.sql")"
if [[ "$(tail -n 1 <<< "$concurrency_output")" != 'MUNERAL_KB_CONCURRENCY_PASS' ]]; then
  echo 'concurrency smoke did not emit its success marker' >&2
  exit 1
fi

remote_psql_query postgres "CREATE ROLE \"$reader\" NOLOGIN;" >/dev/null
created_reader=1

# PostgreSQL grants TEMPORARY to PUBLIC by default. The disposable database
# explicitly revokes that policy before the reader is tested; production role
# provisioning must make the same intentional choice if TEMP denial is desired.
remote_psql_query "$db" \
  "REVOKE TEMPORARY ON DATABASE \"$db\" FROM PUBLIC;
   REVOKE CREATE ON SCHEMA public FROM PUBLIC;
   GRANT CONNECT ON DATABASE \"$db\" TO \"$reader\";
   GRANT USAGE ON SCHEMA public TO \"$reader\";
   GRANT SELECT ON
     public.muneral_kb_task_changes,
     public.tasks,
     public.projects,
     public.task_tags,
     public.task_checklists,
     public.task_agents,
     public.activity_log,
     public.task_dependencies
   TO \"$reader\";" >/dev/null

effective_privileges="$(remote_psql_query "$db" \
  "SELECT
     pg_catalog.has_database_privilege('$reader', '$db', 'CONNECT')
     AND NOT pg_catalog.has_database_privilege('$reader', '$db', 'TEMPORARY')
     AND pg_catalog.has_schema_privilege('$reader', 'public', 'USAGE')
     AND NOT pg_catalog.has_schema_privilege('$reader', 'public', 'CREATE')
     AND (
       SELECT pg_catalog.bool_and(
         pg_catalog.has_table_privilege('$reader', table_name, 'SELECT')
         AND NOT pg_catalog.has_table_privilege(
           '$reader', table_name,
           'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
         )
       )
       FROM pg_catalog.unnest(ARRAY[
         'public.muneral_kb_task_changes',
         'public.tasks',
         'public.projects',
         'public.task_tags',
         'public.task_checklists',
         'public.task_agents',
         'public.activity_log',
         'public.task_dependencies'
       ]) AS allowed(table_name)
     );")"
if [[ "$effective_privileges" != 't' ]]; then
  echo 'reader effective privilege contract failed' >&2
  exit 1
fi

reader_counts="$(remote_psql_query "$db" \
  "SET ROLE \"$reader\";
   SELECT count(*) FROM public.muneral_kb_task_changes;
   SELECT count(*) FROM public.tasks;")"
if [[ "$reader_counts" != $'6\n6' ]]; then
  echo 'reader SELECT registry/source counts failed' >&2
  exit 1
fi

# Test-only fault injection proves the EXIT trap removes both cluster-global
# role state and the disposable database on a mid-run failure.
if [[ "${MUNERAL_SMOKE_TEST_FAIL_AFTER_READER:-0}" == '1' ]]; then
  echo 'injected failure after reader setup' >&2
  exit 97
fi

expect_denied() {
  local label="$1"
  local statement="$2"
  local output
  local status
  set +e
  output="$(remote_psql_query "$db" \
    "SET ROLE \"$reader\"; $statement" 2>&1)"
  status="$?"
  set -e
  if [[ "$status" -eq 0 ]]; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! grep -qiF 'permission denied' <<< "$output"; then
    echo "$label failed for a reason other than permission denied" >&2
    exit 1
  fi
}

expect_denied 'reader source DML' \
  'UPDATE public.tasks SET title = title;'
expect_denied 'reader registry DML' \
  "INSERT INTO public.muneral_kb_task_changes(task_id, revision, changed_at, deleted) VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 1, now(), false);"
expect_denied 'reader durable schema DDL' \
  'CREATE SCHEMA reader_forbidden;'
expect_denied 'reader durable table DDL' \
  'CREATE TABLE public.reader_forbidden(id integer);'
expect_denied 'reader TEMP DDL' \
  'CREATE TEMP TABLE reader_forbidden(id integer);'

remote_psql_file "$db" \
  "$PRISMA_DIR/migrations/20260715170000_add_muneral_kb_task_changes/rollback.sql" \
  >/dev/null
rollback_output="$(remote_psql_file "$db" \
  "$SCRIPT_DIR/muneral_kb_change_registry_post_rollback.sql")"
if [[ "$(tail -n 1 <<< "$rollback_output")" != 'MUNERAL_KB_CHANGE_REGISTRY_ROLLBACK_PASS' ]]; then
  echo 'registry rollback smoke did not emit its success marker' >&2
  exit 1
fi

cleanup
verify_no_residue
trap - EXIT
echo 'MUNERAL_KB_REAL_PG_SMOKE_PASS'
