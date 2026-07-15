\set ON_ERROR_STOP on

-- Seed one task before the registry migration so the post-migration smoke can
-- prove that applying the migration performs no implicit backfill.
INSERT INTO public.users(id, name, created_at, updated_at)
VALUES ('10000000-0000-0000-0000-000000000001', 'smoke owner', now(), now());

INSERT INTO public.workspaces(id, slug, name, owner_id, created_at)
VALUES (
    '20000000-0000-0000-0000-000000000001',
    'smoke',
    'smoke',
    '10000000-0000-0000-0000-000000000001',
    now()
);

INSERT INTO public.projects(id, workspace_id, slug, name, created_at)
VALUES (
    '30000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'project',
    'project',
    now()
);

INSERT INTO public.agents(id, workspace_id, name, capabilities, created_at)
VALUES (
    '40000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'smoke agent',
    '{}'::jsonb,
    now()
);

INSERT INTO public.tasks(id, project_id, title, status, priority, created_at, updated_at)
VALUES (
    'a0000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    'existing before migration',
    'todo',
    'medium',
    now(),
    now()
);
