-- ARCA-0195 WP-21: make result ownership an issued Muneral fact.
--
-- The result seam was disabled by default. Refuse an implicit backfill if an
-- operator enabled it and created bindings: authority must be reconciled from
-- the original Task Card projection, never inferred from result rows.
DO $guard$
BEGIN
    IF EXISTS (SELECT 1 FROM public.task_result_bindings LIMIT 1) THEN
        RAISE EXCEPTION
            'ARCA-0195 issued-invocation migration refused: existing bindings require reconciliation from canonical Task Card projections'
            USING ERRCODE = 'MUN01';
    END IF;
END;
$guard$;

ALTER TABLE public.task_result_bindings
    ADD COLUMN invocation_id VARCHAR(256) NOT NULL,
    ADD COLUMN node_id VARCHAR(256) NOT NULL,
    ADD COLUMN tenant_id VARCHAR(256) NOT NULL,
    ADD COLUMN operation VARCHAR(64) NOT NULL,
    ADD COLUMN card_canonical_bytes TEXT NOT NULL,
    ADD COLUMN projection_canonical_bytes TEXT NOT NULL,
    ADD CONSTRAINT task_result_bindings_invocation_unique UNIQUE (invocation_id),
    ADD CONSTRAINT task_result_bindings_operation_check
        CHECK (operation = 'native.fixture.digest-v0'),
    ADD CONSTRAINT task_result_bindings_card_bytes_check
        CHECK (octet_length(card_canonical_bytes) BETWEEN 2 AND 65536),
    ADD CONSTRAINT task_result_bindings_projection_bytes_check
        CHECK (octet_length(projection_canonical_bytes) BETWEEN 2 AND 262144);

CREATE INDEX idx_task_result_bindings_node
    ON public.task_result_bindings(task_id, node_id);
