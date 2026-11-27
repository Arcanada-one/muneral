-- Ensure every workspace owner has a membership row.
-- Inserts only, and only where the owner has no row; safe to run again.
INSERT INTO public.workspace_members (workspace_id, user_id, role)
SELECT w.id, w.owner_id, 'owner'
  FROM public.workspaces AS w
 WHERE NOT EXISTS (
         SELECT 1
           FROM public.workspace_members AS m
          WHERE m.workspace_id = w.id
            AND m.user_id = w.owner_id
       )
ON CONFLICT (workspace_id, user_id) DO NOTHING;
