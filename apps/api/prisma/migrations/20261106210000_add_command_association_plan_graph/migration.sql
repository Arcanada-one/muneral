-- KCLIVE-10: durable command-to-run/task association + owner-managed plan graph.
-- Additive only. Distinct from migration-only tasks.revision and from lab projections.

-- ---------------------------------------------------------------------------
-- Command association (create/run retries)
-- ---------------------------------------------------------------------------
CREATE TABLE public.task_command_associations (
    id UUID NOT NULL,
    actor_type VARCHAR(16) NOT NULL,
    actor_id UUID NOT NULL,
    project_id UUID NOT NULL,
    operation VARCHAR(64) NOT NULL,
    idempotency_key VARCHAR(256) NOT NULL,
    command_digest VARCHAR(64) NOT NULL,
    root_task_id UUID NULL,
    run_id UUID NULL,
    response JSONB NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT task_command_associations_pkey PRIMARY KEY (id),
    CONSTRAINT task_command_associations_actor_type_check
      CHECK (actor_type IN ('human', 'agent')),
    CONSTRAINT task_command_associations_digest_check
      CHECK (command_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT task_command_associations_project_fkey
      FOREIGN KEY (project_id) REFERENCES public.projects(id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT task_command_associations_root_task_fkey
      FOREIGN KEY (root_task_id) REFERENCES public.tasks(id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT task_command_associations_scope_key_unique
      UNIQUE (actor_type, actor_id, project_id, operation, idempotency_key)
);

CREATE INDEX idx_task_command_associations_root_task
  ON public.task_command_associations(root_task_id);
CREATE INDEX idx_task_command_associations_project
  ON public.task_command_associations(project_id);

COMMENT ON TABLE public.task_command_associations IS
  'KCLIVE-10: durable idempotent command-to-root/run association scoped by principal+project+operation; same key+digest replays, different digest conflicts.';

-- ---------------------------------------------------------------------------
-- Owner-managed plan revisions (authoritative; not Task.revision)
-- ---------------------------------------------------------------------------
CREATE TABLE public.task_plan_revisions (
    id UUID NOT NULL,
    root_task_id UUID NOT NULL,
    revision BIGINT NOT NULL,
    plan_digest VARCHAR(64) NOT NULL,
    snapshot JSONB NOT NULL,
    created_by_type VARCHAR(16) NOT NULL,
    created_by_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT task_plan_revisions_pkey PRIMARY KEY (id),
    CONSTRAINT task_plan_revisions_revision_positive CHECK (revision >= 1),
    CONSTRAINT task_plan_revisions_digest_check
      CHECK (plan_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT task_plan_revisions_actor_type_check
      CHECK (created_by_type IN ('human', 'agent')),
    CONSTRAINT task_plan_revisions_root_task_fkey
      FOREIGN KEY (root_task_id) REFERENCES public.tasks(id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT task_plan_revisions_root_revision_unique
      UNIQUE (root_task_id, revision)
);

CREATE INDEX idx_task_plan_revisions_root
  ON public.task_plan_revisions(root_task_id);

COMMENT ON TABLE public.task_plan_revisions IS
  'KCLIVE-10: owner-managed authoritative plan/graph revisions. Distinct from migration CAS Task.revision and from any lab read projection.';

CREATE TABLE public.task_plan_heads (
    root_task_id UUID NOT NULL,
    revision BIGINT NOT NULL,
    plan_digest VARCHAR(64) NOT NULL,
    lease_holder VARCHAR(128) NULL,
    lease_expires_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT task_plan_heads_pkey PRIMARY KEY (root_task_id),
    CONSTRAINT task_plan_heads_revision_positive CHECK (revision >= 1),
    CONSTRAINT task_plan_heads_digest_check
      CHECK (plan_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT task_plan_heads_root_task_fkey
      FOREIGN KEY (root_task_id) REFERENCES public.tasks(id)
      ON DELETE RESTRICT ON UPDATE RESTRICT
);

COMMENT ON TABLE public.task_plan_heads IS
  'KCLIVE-10: current authoritative plan head + optional execution lease bound to that revision (CAS target).';
