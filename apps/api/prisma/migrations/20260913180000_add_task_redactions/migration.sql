-- MUN-0049: record each removed secret-shaped span of a task title/description.
--
-- Purpose. The Scrutator kb-sync scanner blocks a task by (rule, sha256 of the
-- span) and never by cleartext. POST /tasks/:taskId/redactions removes exactly
-- that span from the current field value. This table is the redaction's own
-- record — which span (by hash), which rule, what replaced it, the field value
-- before and after (by hash), who and when — and its UNIQUE index is what makes
-- the route idempotent: a repeat of (task, field, span) finds this row instead
-- of reporting the (now absent) span as a conflict.
--
-- Additive only. No existing table or column changes. The cleartext of the span
-- is stored nowhere: every *_sha256 column is constrained to 64 hex characters.
-- ON DELETE CASCADE with tasks: the activity_log row written in the same
-- transaction (action 'task:redacted', task_id SET NULL on delete) is the audit
-- record that outlives the task; this row is the task's own idempotency key.

CREATE TABLE public.task_redactions (
    id UUID NOT NULL DEFAULT uuid_generate_v4(),
    task_id UUID NOT NULL,
    field VARCHAR(32) NOT NULL,
    rule VARCHAR(64) NOT NULL,
    span_sha256 VARCHAR(64) NOT NULL,
    replacement VARCHAR(512) NOT NULL,
    previous_value_sha256 VARCHAR(64) NOT NULL,
    new_value_sha256 VARCHAR(64) NOT NULL,
    occurrences INTEGER NOT NULL,
    actor_type VARCHAR NOT NULL,
    actor_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT task_redactions_pkey PRIMARY KEY (id),
    CONSTRAINT task_redactions_task_field_span_unique UNIQUE (task_id, field, span_sha256),
    CONSTRAINT task_redactions_field_check CHECK (field IN ('title', 'description')),
    CONSTRAINT task_redactions_span_sha256_check CHECK (span_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT task_redactions_previous_sha256_check CHECK (previous_value_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT task_redactions_new_sha256_check CHECK (new_value_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT task_redactions_values_differ_check CHECK (previous_value_sha256 <> new_value_sha256),
    CONSTRAINT task_redactions_replacement_check CHECK (length(replacement) > 0),
    CONSTRAINT task_redactions_occurrences_check CHECK (occurrences > 0),
    CONSTRAINT task_redactions_actor_type_check CHECK (actor_type IN ('human', 'agent')),
    CONSTRAINT task_redactions_task_fkey FOREIGN KEY (task_id)
        REFERENCES public.tasks(id) ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE INDEX idx_task_redactions_task_id ON public.task_redactions(task_id);
