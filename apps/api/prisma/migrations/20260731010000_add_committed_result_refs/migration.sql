-- MUN-0021 adoption gate: Muneral-owned committed-result nodes and references.
--
-- Ratified in datarim/research/ARCA-0194/muneral-result-reference-consilium.md:
-- MUN-0022 may remain a pure contract proof, but the additive Muneral relation
-- is mandatory here. Storing the reference only in transition JSON would leave
-- semantic uniqueness, foreign-key integrity and crash-safe readback as
-- application-only guarantees.
--
-- Additive only. No backfill, no existing-row rewrite.
-- Disabled-by-default: no AppModule, controller, or runtime wiring.
-- These are immutable Muneral task facts. Nothing here models a fleet
-- registry, process lifecycle, placement, staged rollout, watchdog, telemetry
-- aggregation, or direct command routing.

-- ---------------------------------------------------------------------------
-- task_result_nodes — the accepted owned node mutation
-- ---------------------------------------------------------------------------
-- One row per accepted mutation of a Task Card result node. Append-only: a new
-- result is a new node version, never an in-place rewrite.
CREATE TABLE public.task_result_nodes (
    id            UUID          NOT NULL,
    task_id       UUID          NOT NULL,
    attempt_id    UUID          NOT NULL,
    card_id       VARCHAR(256)  NOT NULL,
    node_id       VARCHAR(256)  NOT NULL,
    node_version  INTEGER       NOT NULL,
    mutation_id   VARCHAR(256)  NOT NULL,
    principal_id  VARCHAR(256)  NOT NULL,
    node_payload  JSONB         NOT NULL,
    result_digest VARCHAR(64)   NOT NULL,
    recorded_at   TIMESTAMPTZ   NOT NULL,

    CONSTRAINT task_result_nodes_pkey PRIMARY KEY (id),
    CONSTRAINT task_result_nodes_id_task_unique UNIQUE (id, task_id),
    CONSTRAINT task_result_nodes_node_version_unique
        UNIQUE (task_id, node_id, node_version),
    CONSTRAINT task_result_nodes_mutation_unique UNIQUE (task_id, mutation_id),
    CONSTRAINT task_result_nodes_node_version_check CHECK (node_version >= 1),
    CONSTRAINT task_result_nodes_result_digest_check
        CHECK (result_digest ~ '^[0-9a-f]{64}$')
);

-- ---------------------------------------------------------------------------
-- task_committed_result_refs — the closed committed-result reference
-- ---------------------------------------------------------------------------
-- One row per committed result. Carries the ratified CommittedResultRefV0
-- identity plus the deterministic completion-receipt identity. The receipt is
-- a pure function of these columns, so a receipt row exists exactly when its
-- reference does — there is no window in which one can exist without the other.
--
-- The reference carries no result body: the committed node bytes live in
-- task_result_nodes and are addressed by result_digest.
CREATE TABLE public.task_committed_result_refs (
    result_ref_id     VARCHAR(64)   NOT NULL,
    task_id           UUID          NOT NULL,
    attempt_id        UUID          NOT NULL,
    card_id           VARCHAR(256)  NOT NULL,
    card_digest       VARCHAR(64)   NOT NULL,
    projection_id     VARCHAR(256)  NOT NULL,
    projection_digest VARCHAR(64)   NOT NULL,
    node_id           VARCHAR(256)  NOT NULL,
    node_version      INTEGER       NOT NULL,
    result_digest     VARCHAR(64)   NOT NULL,
    mutation_id       VARCHAR(256)  NOT NULL,
    principal_id      VARCHAR(256)  NOT NULL,
    transition_id     UUID          NOT NULL,
    aggregate_version BIGINT        NOT NULL,
    result_node_id    UUID          NOT NULL,
    receipt_id        VARCHAR(64)   NOT NULL,
    causation_id      VARCHAR(256)  NOT NULL,
    correlation_id    VARCHAR(256)  NOT NULL,
    recorded_at       TIMESTAMPTZ   NOT NULL,

    CONSTRAINT task_committed_result_refs_pkey PRIMARY KEY (result_ref_id),

    -- Transition identity: a committed transition has at most one reference.
    CONSTRAINT task_committed_result_refs_transition_unique UNIQUE (transition_id),
    CONSTRAINT task_committed_result_refs_transition_task_unique UNIQUE (transition_id, task_id),

    -- Semantic identity: two writers at one node version cannot both commit.
    CONSTRAINT task_committed_result_refs_semantic_unique
        UNIQUE (task_id, attempt_id, card_id, node_id, node_version),

    -- Mutation identity: repeating a mutation replays, it does not duplicate.
    CONSTRAINT task_committed_result_refs_mutation_unique UNIQUE (task_id, mutation_id),

    -- A different receipt id cannot commit the same semantic result, and one
    -- receipt id cannot be reused for a different result.
    CONSTRAINT task_committed_result_refs_receipt_unique UNIQUE (receipt_id),

    CONSTRAINT task_committed_result_refs_node_version_check CHECK (node_version >= 1),
    CONSTRAINT task_committed_result_refs_aggregate_version_check
        CHECK (aggregate_version > 0),
    CONSTRAINT task_committed_result_refs_result_ref_id_check
        CHECK (result_ref_id ~ '^[0-9a-f]{64}$'),
    CONSTRAINT task_committed_result_refs_receipt_id_check
        CHECK (receipt_id ~ '^[0-9a-f]{64}$'),
    CONSTRAINT task_committed_result_refs_card_digest_check
        CHECK (card_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT task_committed_result_refs_projection_digest_check
        CHECK (projection_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT task_committed_result_refs_result_digest_check
        CHECK (result_digest ~ '^[0-9a-f]{64}$'),

    -- The instruction, projection and result integrity domains are distinct.
    -- A receipt bound to instructions rather than to the committed result
    -- could claim success before any result exists.
    CONSTRAINT task_committed_result_refs_domain_separation_check
        CHECK (result_digest <> card_digest
               AND result_digest <> projection_digest
               AND receipt_id <> card_digest
               AND receipt_id <> projection_digest
               AND result_ref_id <> card_digest
               AND result_ref_id <> projection_digest)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX idx_task_result_nodes_task_node
    ON public.task_result_nodes(task_id, node_id);

CREATE INDEX idx_task_result_nodes_attempt
    ON public.task_result_nodes(attempt_id);

CREATE INDEX idx_task_committed_result_refs_task_card
    ON public.task_committed_result_refs(task_id, card_id);

CREATE INDEX idx_task_committed_result_refs_recorded_at
    ON public.task_committed_result_refs(recorded_at);

-- ---------------------------------------------------------------------------
-- Foreign keys (RESTRICT — no silent cascade delete)
-- ---------------------------------------------------------------------------

ALTER TABLE public.task_result_nodes
    ADD CONSTRAINT task_result_nodes_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES public.tasks(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE public.task_result_nodes
    ADD CONSTRAINT task_result_nodes_attempt_task_fkey
    FOREIGN KEY (attempt_id, task_id)
    REFERENCES public.task_execution_attempts(attempt_id, task_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE public.task_committed_result_refs
    ADD CONSTRAINT task_committed_result_refs_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES public.tasks(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE public.task_committed_result_refs
    ADD CONSTRAINT task_committed_result_refs_attempt_task_fkey
    FOREIGN KEY (attempt_id, task_id)
    REFERENCES public.task_execution_attempts(attempt_id, task_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Composite FK: a reference with task_id=A cannot bind a transition owned by
-- task_id=B while this constraint passes.
ALTER TABLE public.task_committed_result_refs
    ADD CONSTRAINT task_committed_result_refs_transition_task_fkey
    FOREIGN KEY (transition_id, task_id)
    REFERENCES public.task_execution_transitions(id, task_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Composite FK: a reference cannot address a result node owned by another task.
ALTER TABLE public.task_committed_result_refs
    ADD CONSTRAINT task_committed_result_refs_node_task_fkey
    FOREIGN KEY (result_node_id, task_id)
    REFERENCES public.task_result_nodes(id, task_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Append-only guard triggers
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.task_result_nodes_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'task_result_nodes is append-only: UPDATE rejected for id=%', OLD.id
            USING ERRCODE = 'MUN00';
    ELSIF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'task_result_nodes is append-only: DELETE rejected for id=%', OLD.id
            USING ERRCODE = 'MUN00';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.task_result_nodes_guard() FROM PUBLIC;

CREATE TRIGGER task_result_nodes_append_only
BEFORE UPDATE OR DELETE ON public.task_result_nodes
FOR EACH ROW EXECUTE FUNCTION public.task_result_nodes_guard();

CREATE FUNCTION public.task_committed_result_refs_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'task_committed_result_refs is append-only: UPDATE rejected for result_ref_id=%', OLD.result_ref_id
            USING ERRCODE = 'MUN00';
    ELSIF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'task_committed_result_refs is append-only: DELETE rejected for result_ref_id=%', OLD.result_ref_id
            USING ERRCODE = 'MUN00';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.task_committed_result_refs_guard() FROM PUBLIC;

CREATE TRIGGER task_committed_result_refs_append_only
BEFORE UPDATE OR DELETE ON public.task_committed_result_refs
FOR EACH ROW EXECUTE FUNCTION public.task_committed_result_refs_guard();
