-- LTM-0025 rollback: remove only registry-owned objects. Domain data is not
-- changed, truncated, or deleted.

DROP TRIGGER IF EXISTS muneral_kb_projects_changed ON public.projects;
DROP TRIGGER IF EXISTS muneral_kb_task_dependencies_changed ON public.task_dependencies;
DROP TRIGGER IF EXISTS muneral_kb_activity_log_changed ON public.activity_log;
DROP TRIGGER IF EXISTS muneral_kb_task_agents_changed ON public.task_agents;
DROP TRIGGER IF EXISTS muneral_kb_task_checklists_changed ON public.task_checklists;
DROP TRIGGER IF EXISTS muneral_kb_task_tags_changed ON public.task_tags;
DROP TRIGGER IF EXISTS muneral_kb_tasks_changed ON public.tasks;

DROP FUNCTION IF EXISTS public.muneral_kb_project_changed();
DROP FUNCTION IF EXISTS public.muneral_kb_task_dependency_changed();
DROP FUNCTION IF EXISTS public.muneral_kb_task_child_changed();
DROP FUNCTION IF EXISTS public.muneral_kb_tasks_changed();
DROP FUNCTION IF EXISTS public.muneral_kb_touch_task(uuid, boolean);

DROP TABLE IF EXISTS public.muneral_kb_task_changes;
