-- MUN-0020 execution-authority disposable harness preseed.
-- Creates the minimum workspace/project/task rows needed for contract proofs.
-- All UUIDs are hard-coded for deterministic test assertions.

-- User for workspace ownership
INSERT INTO public.users (id, name, updated_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'Smoke Test User', now());

-- Workspace
INSERT INTO public.workspaces (id, slug, name, owner_id)
VALUES ('10000000-0000-0000-0000-000000000001', 'smoke-ws', 'Smoke Workspace', '00000000-0000-0000-0000-000000000001');

-- Project
INSERT INTO public.projects (id, workspace_id, slug, name)
VALUES ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'smoke-project', 'Smoke Project');

-- Tasks (two for concurrency testing)
INSERT INTO public.tasks (id, project_id, title, status, priority, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Smoke Task 1', 'todo', 'medium', now()),
  ('a0000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Smoke Task 2', 'todo', 'medium', now());
