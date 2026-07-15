-- LTM-0025: transactionally record each task graph mutation for KB sync.
-- This migration deliberately does not backfill existing tasks. A separate,
-- operator-gated backfill owns that decision.

CREATE TABLE public.muneral_kb_task_changes (
    task_id UUID NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    changed_at TIMESTAMPTZ NOT NULL,
    deleted BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT muneral_kb_task_changes_pkey PRIMARY KEY (task_id)
);

CREATE FUNCTION public.muneral_kb_touch_task(
    p_task_id UUID,
    p_deleted BOOLEAN DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF p_task_id IS NULL THEN
        RETURN;
    END IF;

    INSERT INTO public.muneral_kb_task_changes AS registry (
        task_id,
        revision,
        changed_at,
        deleted
    )
    VALUES (
        p_task_id,
        1,
        pg_catalog.clock_timestamp(),
        COALESCE(p_deleted, false)
    )
    ON CONFLICT (task_id) DO UPDATE
    SET revision = registry.revision + 1,
        changed_at = EXCLUDED.changed_at,
        deleted = CASE
            WHEN p_deleted IS NULL THEN registry.deleted
            ELSE p_deleted
        END;
END;
$function$;

CREATE FUNCTION public.muneral_kb_tasks_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM public.muneral_kb_touch_task(OLD.id, true);
        RETURN OLD;
    END IF;

    PERFORM public.muneral_kb_touch_task(NEW.id, false);
    RETURN NEW;
END;
$function$;

CREATE FUNCTION public.muneral_kb_task_child_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_task_id UUID;
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM public.muneral_kb_touch_task(NEW.task_id, NULL);
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.muneral_kb_touch_task(OLD.task_id, NULL);
        RETURN OLD;
    END IF;

    FOR v_task_id IN
        SELECT DISTINCT endpoints.task_id
        FROM (
            SELECT OLD.task_id
            UNION ALL
            SELECT NEW.task_id
        ) AS endpoints(task_id)
        WHERE endpoints.task_id IS NOT NULL
        ORDER BY endpoints.task_id
    LOOP
        PERFORM public.muneral_kb_touch_task(v_task_id, NULL);
    END LOOP;
    RETURN NEW;
END;
$function$;

CREATE FUNCTION public.muneral_kb_task_dependency_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_task_id UUID;
BEGIN
    IF TG_OP = 'INSERT' THEN
        FOR v_task_id IN
            SELECT DISTINCT endpoints.task_id
            FROM (
                SELECT NEW.from_task_id
                UNION ALL
                SELECT NEW.to_task_id
            ) AS endpoints(task_id)
            WHERE endpoints.task_id IS NOT NULL
            ORDER BY endpoints.task_id
        LOOP
            PERFORM public.muneral_kb_touch_task(v_task_id, NULL);
        END LOOP;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        FOR v_task_id IN
            SELECT DISTINCT endpoints.task_id
            FROM (
                SELECT OLD.from_task_id
                UNION ALL
                SELECT OLD.to_task_id
            ) AS endpoints(task_id)
            WHERE endpoints.task_id IS NOT NULL
            ORDER BY endpoints.task_id
        LOOP
            PERFORM public.muneral_kb_touch_task(v_task_id, NULL);
        END LOOP;
        RETURN OLD;
    END IF;

    FOR v_task_id IN
        SELECT DISTINCT endpoints.task_id
        FROM (
            SELECT OLD.from_task_id
            UNION ALL
            SELECT OLD.to_task_id
            UNION ALL
            SELECT NEW.from_task_id
            UNION ALL
            SELECT NEW.to_task_id
        ) AS endpoints(task_id)
        WHERE endpoints.task_id IS NOT NULL
        ORDER BY endpoints.task_id
    LOOP
        PERFORM public.muneral_kb_touch_task(v_task_id, NULL);
    END LOOP;
    RETURN NEW;
END;
$function$;

CREATE FUNCTION public.muneral_kb_project_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_task_id UUID;
BEGIN
    IF OLD.name IS NOT DISTINCT FROM NEW.name
       AND OLD.slug IS NOT DISTINCT FROM NEW.slug THEN
        RETURN NEW;
    END IF;

    FOR v_task_id IN
        SELECT source_task.id
        FROM public.tasks AS source_task
        WHERE source_task.project_id = NEW.id
        ORDER BY source_task.id
    LOOP
        PERFORM public.muneral_kb_touch_task(v_task_id, NULL);
    END LOOP;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.muneral_kb_touch_task(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.muneral_kb_tasks_changed() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.muneral_kb_task_child_changed() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.muneral_kb_task_dependency_changed() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.muneral_kb_project_changed() FROM PUBLIC;

CREATE TRIGGER muneral_kb_tasks_changed
AFTER INSERT OR UPDATE OR DELETE ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.muneral_kb_tasks_changed();

CREATE TRIGGER muneral_kb_task_tags_changed
AFTER INSERT OR UPDATE OR DELETE ON public.task_tags
FOR EACH ROW EXECUTE FUNCTION public.muneral_kb_task_child_changed();

CREATE TRIGGER muneral_kb_task_checklists_changed
AFTER INSERT OR UPDATE OR DELETE ON public.task_checklists
FOR EACH ROW EXECUTE FUNCTION public.muneral_kb_task_child_changed();

CREATE TRIGGER muneral_kb_task_agents_changed
AFTER INSERT OR UPDATE OR DELETE ON public.task_agents
FOR EACH ROW EXECUTE FUNCTION public.muneral_kb_task_child_changed();

CREATE TRIGGER muneral_kb_activity_log_changed
AFTER INSERT OR UPDATE OR DELETE ON public.activity_log
FOR EACH ROW EXECUTE FUNCTION public.muneral_kb_task_child_changed();

CREATE TRIGGER muneral_kb_task_dependencies_changed
AFTER INSERT OR UPDATE OR DELETE ON public.task_dependencies
FOR EACH ROW EXECUTE FUNCTION public.muneral_kb_task_dependency_changed();

CREATE TRIGGER muneral_kb_projects_changed
AFTER UPDATE OF name, slug ON public.projects
FOR EACH ROW EXECUTE FUNCTION public.muneral_kb_project_changed();
