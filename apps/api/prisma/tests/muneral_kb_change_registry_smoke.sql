\set ON_ERROR_STOP on

-- The runner creates task a000...001 before applying the registry migration.
-- Its absence here proves the migration does not seed existing tasks.
DO $test$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.muneral_kb_task_changes
        WHERE task_id = 'a0000000-0000-0000-0000-000000000001'::uuid
    ) THEN
        RAISE EXCEPTION 'migration unexpectedly seeded an existing task';
    END IF;
END;
$test$;

CREATE FUNCTION pg_temp.assert_registry(
    p_task_id uuid,
    p_revision bigint,
    p_deleted boolean,
    p_context text
)
RETURNS void
LANGUAGE plpgsql
AS $test$
DECLARE
    v_revision bigint;
    v_deleted boolean;
BEGIN
    SELECT changes.revision, changes.deleted
    INTO v_revision, v_deleted
    FROM public.muneral_kb_task_changes AS changes
    WHERE changes.task_id = p_task_id;

    IF v_revision IS DISTINCT FROM p_revision
       OR v_deleted IS DISTINCT FROM p_deleted THEN
        RAISE EXCEPTION '%: expected revision %, deleted %, got revision %, deleted %',
            p_context, p_revision, p_deleted, v_revision, v_deleted;
    END IF;
END;
$test$;

-- Task UPDATE creates a first registry entry for the pre-migration task.
UPDATE public.tasks
SET title = 'existing task updated after migration'
WHERE id = 'a0000000-0000-0000-0000-000000000001'::uuid;
SELECT pg_temp.assert_registry(
    'a0000000-0000-0000-0000-000000000001', 1, false, 'task update'
);

-- Registry changes participate in and roll back with the domain transaction.
BEGIN;
UPDATE public.tasks
SET title = 'transaction must roll back'
WHERE id = 'a0000000-0000-0000-0000-000000000001'::uuid;
SELECT pg_temp.assert_registry(
    'a0000000-0000-0000-0000-000000000001', 2, false, 'in-transaction update'
);
ROLLBACK;
SELECT pg_temp.assert_registry(
    'a0000000-0000-0000-0000-000000000001', 1, false, 'rolled-back registry update'
);
DO $test$
BEGIN
    IF (SELECT title FROM public.tasks
        WHERE id = 'a0000000-0000-0000-0000-000000000001'::uuid)
       <> 'existing task updated after migration' THEN
        RAISE EXCEPTION 'domain update did not roll back';
    END IF;
END;
$test$;

-- Task INSERT/UPDATE/DELETE, followed by resurrection of the same UUID.
INSERT INTO public.tasks (
    id, project_id, title, status, priority, created_at, updated_at
) VALUES (
    'a0000000-0000-0000-0000-000000000002',
    '30000000-0000-0000-0000-000000000001',
    'task B', 'todo', 'medium', pg_catalog.now(), pg_catalog.now()
);
SELECT pg_temp.assert_registry(
    'a0000000-0000-0000-0000-000000000002', 1, false, 'task insert'
);
UPDATE public.tasks SET title = 'task B updated'
WHERE id = 'a0000000-0000-0000-0000-000000000002'::uuid;
SELECT pg_temp.assert_registry(
    'a0000000-0000-0000-0000-000000000002', 2, false, 'task update after insert'
);
DELETE FROM public.tasks
WHERE id = 'a0000000-0000-0000-0000-000000000002'::uuid;
SELECT pg_temp.assert_registry(
    'a0000000-0000-0000-0000-000000000002', 3, true, 'task tombstone'
);
INSERT INTO public.tasks (
    id, project_id, title, status, priority, created_at, updated_at
) VALUES (
    'a0000000-0000-0000-0000-000000000002',
    '30000000-0000-0000-0000-000000000001',
    'task B restored', 'todo', 'medium', pg_catalog.now(), pg_catalog.now()
);
SELECT pg_temp.assert_registry(
    'a0000000-0000-0000-0000-000000000002', 4, false, 'task resurrection clears tombstone'
);

-- Additional tasks used by child, dependency, fanout, and cascade cases.
INSERT INTO public.tasks (
    id, project_id, title, status, priority, created_at, updated_at
) VALUES
    ('a0000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000001', 'task C', 'todo', 'medium', pg_catalog.now(), pg_catalog.now()),
    ('a0000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000001', 'task D', 'todo', 'medium', pg_catalog.now(), pg_catalog.now()),
    ('a0000000-0000-0000-0000-000000000005', '30000000-0000-0000-0000-000000000001', 'task E', 'todo', 'medium', pg_catalog.now(), pg_catalog.now()),
    ('a0000000-0000-0000-0000-000000000006', '30000000-0000-0000-0000-000000000001', 'task F', 'todo', 'medium', pg_catalog.now(), pg_catalog.now());

-- task_tags INSERT / UPDATE / DELETE.
INSERT INTO public.task_tags(task_id, tag)
VALUES ('a0000000-0000-0000-0000-000000000003', 'alpha');
UPDATE public.task_tags SET tag = 'beta'
WHERE task_id = 'a0000000-0000-0000-0000-000000000003'::uuid AND tag = 'alpha';
DELETE FROM public.task_tags
WHERE task_id = 'a0000000-0000-0000-0000-000000000003'::uuid AND tag = 'beta';
SELECT pg_temp.assert_registry(
    'a0000000-0000-0000-0000-000000000003', 4, false, 'task_tags I/U/D'
);

-- task_checklists INSERT / UPDATE / DELETE.
INSERT INTO public.task_checklists(id, task_id, text, checked, created_at)
VALUES ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000003', 'one', false, pg_catalog.now());
UPDATE public.task_checklists SET checked = true
WHERE id = 'b0000000-0000-0000-0000-000000000001'::uuid;
DELETE FROM public.task_checklists
WHERE id = 'b0000000-0000-0000-0000-000000000001'::uuid;
SELECT pg_temp.assert_registry(
    'a0000000-0000-0000-0000-000000000003', 7, false, 'task_checklists I/U/D'
);

-- task_agents INSERT / UPDATE / DELETE.
INSERT INTO public.task_agents(task_id, agent_id, role, assigned_at)
VALUES ('a0000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000001', 'lead', pg_catalog.now());
UPDATE public.task_agents SET role = 'reviewer'
WHERE task_id = 'a0000000-0000-0000-0000-000000000003'::uuid
  AND agent_id = '40000000-0000-0000-0000-000000000001'::uuid;
DELETE FROM public.task_agents
WHERE task_id = 'a0000000-0000-0000-0000-000000000003'::uuid
  AND agent_id = '40000000-0000-0000-0000-000000000001'::uuid;
SELECT pg_temp.assert_registry(
    'a0000000-0000-0000-0000-000000000003', 10, false, 'task_agents I/U/D'
);

-- activity_log handles nullable task_id on both OLD and NEW sides.
INSERT INTO public.activity_log(
    id, task_id, workspace_id, actor_type, actor_id, action, created_at
) VALUES (
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000003',
    '20000000-0000-0000-0000-000000000001',
    'human', '10000000-0000-0000-0000-000000000001', 'created', pg_catalog.now()
);
UPDATE public.activity_log SET task_id = NULL
WHERE id = 'c0000000-0000-0000-0000-000000000001'::uuid;
UPDATE public.activity_log SET task_id = 'a0000000-0000-0000-0000-000000000003'
WHERE id = 'c0000000-0000-0000-0000-000000000001'::uuid;
DELETE FROM public.activity_log
WHERE id = 'c0000000-0000-0000-0000-000000000001'::uuid;
SELECT pg_temp.assert_registry(
    'a0000000-0000-0000-0000-000000000003', 14, false, 'activity_log nullable I/U/U/D'
);

-- Dependency UPDATE touches each distinct OLD/NEW endpoint exactly once.
INSERT INTO public.task_dependencies(id, from_task_id, to_task_id, type)
VALUES (
    'd0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000003',
    'a0000000-0000-0000-0000-000000000004',
    'depends_on'
);
SELECT pg_temp.assert_registry('a0000000-0000-0000-0000-000000000003', 15, false, 'dependency insert from');
SELECT pg_temp.assert_registry('a0000000-0000-0000-0000-000000000004', 2, false, 'dependency insert to');
UPDATE public.task_dependencies
SET from_task_id = 'a0000000-0000-0000-0000-000000000004',
    to_task_id = 'a0000000-0000-0000-0000-000000000005'
WHERE id = 'd0000000-0000-0000-0000-000000000001'::uuid;
SELECT pg_temp.assert_registry('a0000000-0000-0000-0000-000000000003', 16, false, 'dependency update old from');
SELECT pg_temp.assert_registry('a0000000-0000-0000-0000-000000000004', 3, false, 'dependency update shared endpoint once');
SELECT pg_temp.assert_registry('a0000000-0000-0000-0000-000000000005', 2, false, 'dependency update new to');
DELETE FROM public.task_dependencies
WHERE id = 'd0000000-0000-0000-0000-000000000001'::uuid;
SELECT pg_temp.assert_registry('a0000000-0000-0000-0000-000000000004', 4, false, 'dependency delete from');
SELECT pg_temp.assert_registry('a0000000-0000-0000-0000-000000000005', 3, false, 'dependency delete to');

-- Project name and slug changes fan out to every current member task; a
-- syntactic no-op UPDATE does not create a false revision.
UPDATE public.projects SET name = 'project renamed'
WHERE id = '30000000-0000-0000-0000-000000000001'::uuid;
UPDATE public.projects SET slug = 'project-renamed'
WHERE id = '30000000-0000-0000-0000-000000000001'::uuid;
UPDATE public.projects SET name = name
WHERE id = '30000000-0000-0000-0000-000000000001'::uuid;
SELECT pg_temp.assert_registry('a0000000-0000-0000-0000-000000000001', 3, false, 'project fanout existing');
SELECT pg_temp.assert_registry('a0000000-0000-0000-0000-000000000002', 6, false, 'project fanout restored');
SELECT pg_temp.assert_registry('a0000000-0000-0000-0000-000000000003', 18, false, 'project fanout C');
SELECT pg_temp.assert_registry('a0000000-0000-0000-0000-000000000004', 6, false, 'project fanout D');
SELECT pg_temp.assert_registry('a0000000-0000-0000-0000-000000000005', 5, false, 'project fanout E');
SELECT pg_temp.assert_registry('a0000000-0000-0000-0000-000000000006', 3, false, 'project fanout F');

-- Child cascades following task DELETE must not clear the task tombstone.
INSERT INTO public.task_tags(task_id, tag)
VALUES ('a0000000-0000-0000-0000-000000000006', 'cascade');
INSERT INTO public.task_checklists(id, task_id, text, checked, created_at)
VALUES ('b0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000006', 'cascade', false, pg_catalog.now());
INSERT INTO public.task_agents(task_id, agent_id, role, assigned_at)
VALUES ('a0000000-0000-0000-0000-000000000006', '40000000-0000-0000-0000-000000000001', 'lead', pg_catalog.now());
INSERT INTO public.activity_log(
    id, task_id, workspace_id, actor_type, actor_id, action, created_at
) VALUES (
    'c0000000-0000-0000-0000-000000000006',
    'a0000000-0000-0000-0000-000000000006',
    '20000000-0000-0000-0000-000000000001',
    'human', '10000000-0000-0000-0000-000000000001', 'cascade', pg_catalog.now()
);
INSERT INTO public.task_dependencies(id, from_task_id, to_task_id, type)
VALUES (
    'd0000000-0000-0000-0000-000000000006',
    'a0000000-0000-0000-0000-000000000006',
    'a0000000-0000-0000-0000-000000000003',
    'depends_on'
);
DELETE FROM public.tasks
WHERE id = 'a0000000-0000-0000-0000-000000000006'::uuid;
SELECT pg_temp.assert_registry(
    'a0000000-0000-0000-0000-000000000006', 14, true, 'tombstone survives child cascades'
);
SELECT pg_temp.assert_registry(
    'a0000000-0000-0000-0000-000000000003', 20, false, 'dependency cascade touches peer'
);

DO $test$
BEGIN
    IF EXISTS (SELECT 1 FROM public.task_tags WHERE task_id = 'a0000000-0000-0000-0000-000000000006'::uuid)
       OR EXISTS (SELECT 1 FROM public.task_checklists WHERE task_id = 'a0000000-0000-0000-0000-000000000006'::uuid)
       OR EXISTS (SELECT 1 FROM public.task_agents WHERE task_id = 'a0000000-0000-0000-0000-000000000006'::uuid)
       OR EXISTS (SELECT 1 FROM public.task_dependencies WHERE from_task_id = 'a0000000-0000-0000-0000-000000000006'::uuid OR to_task_id = 'a0000000-0000-0000-0000-000000000006'::uuid)
       OR EXISTS (SELECT 1 FROM public.activity_log WHERE task_id = 'a0000000-0000-0000-0000-000000000006'::uuid) THEN
        RAISE EXCEPTION 'domain cascades did not complete';
    END IF;
END;
$test$;

-- Reinsert proves a task INSERT explicitly clears a prior tombstone.
INSERT INTO public.tasks (
    id, project_id, title, status, priority, created_at, updated_at
) VALUES (
    'a0000000-0000-0000-0000-000000000006',
    '30000000-0000-0000-0000-000000000001',
    'task F restored', 'todo', 'medium', pg_catalog.now(), pg_catalog.now()
);
SELECT pg_temp.assert_registry(
    'a0000000-0000-0000-0000-000000000006', 15, false, 'task insert clears cascade tombstone'
);

-- SECURITY DEFINER functions are owned with the registry table, pin the search
-- path, and expose no PUBLIC execute privilege.
DO $test$
DECLARE
    v_bad_count integer;
BEGIN
    SELECT count(*)
    INTO v_bad_count
    FROM pg_catalog.pg_proc AS proc
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = proc.pronamespace
    JOIN pg_catalog.pg_class AS registry ON registry.relname = 'muneral_kb_task_changes'
    JOIN pg_catalog.pg_namespace AS registry_namespace
      ON registry_namespace.oid = registry.relnamespace
    WHERE namespace.nspname = 'public'
      AND registry_namespace.nspname = 'public'
      AND proc.proname LIKE 'muneral_kb_%'
      AND (
          NOT proc.prosecdef
          OR proc.proowner <> registry.relowner
          OR NOT (proc.proconfig @> ARRAY['search_path=pg_catalog']::text[])
          OR EXISTS (
              SELECT 1
              FROM pg_catalog.aclexplode(proc.proacl) AS acl
              WHERE acl.grantee = 0
                AND acl.privilege_type = 'EXECUTE'
          )
      );
    IF v_bad_count <> 0 THEN
        RAISE EXCEPTION '% registry functions failed security metadata checks', v_bad_count;
    END IF;
END;
$test$;

SELECT 'MUNERAL_KB_CHANGE_REGISTRY_SMOKE_PASS' AS result;
