-- Ensure every workspace owner has a membership row.
-- Inserts only: where a workspace has no member with the owner role and its owner
-- has no row. Safe to run again.
INSERT INTO public.workspace_members (workspace_id, user_id, role)
SELECT w.id, w.owner_id, 'owner'
  FROM public.workspaces AS w
 WHERE NOT EXISTS (
         SELECT 1
           FROM public.workspace_members AS o
          WHERE o.workspace_id = w.id
            AND o.role = 'owner'
       )
   AND NOT EXISTS (
         SELECT 1
           FROM public.workspace_members AS m
          WHERE m.workspace_id = w.id
            AND m.user_id = w.owner_id
       )
ON CONFLICT (workspace_id, user_id) DO NOTHING;
