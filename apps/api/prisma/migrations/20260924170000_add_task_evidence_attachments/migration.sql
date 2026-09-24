-- A2-274 (MUN-EVIDENCE): a work item carries the evidence its executor produced.
--
-- Purpose. A2-P4 ends with an executor (ARAS) that has finished a work item and
-- holds a ReadinessReceipt for it. Until now there was nowhere on the work item
-- to put that receipt: an agent key could comment (MUN-0046), and a comment is
-- free text — a reader cannot tell a receipt from a sentence about one, and
-- nothing binds the bytes it names. This table is the narrowest thing that
-- closes it: WHERE the artefact is (`uri`), WHAT it is (`content_type`), and
-- WHICH BYTES were meant (`sha256`), attributed to the agent that attached it.
--
-- The digest is the identity. UNIQUE (task_id, sha256) is what makes
-- POST /tasks/:taskId/evidence idempotent: a retrying executor — the normal
-- case for an unattended agent that lost its answer, not an error — re-attaches
-- the same bytes and gets the stored row back instead of a second record of one
-- artefact. It is also what lets the route refuse a SECOND uri for the same
-- digest instead of silently keeping the first (EVIDENCE_DIGEST_CONFLICT): two
-- locations claiming one digest is a fact the caller must be told, never one
-- the server picks a winner for.
--
-- The cleartext of the artefact is not stored here and never passes through the
-- API: this table holds a locator and a hash. `sha256` is CHECKed to 64
-- lowercase hex so a value written around the DTO — an importer, a psql session
-- — cannot land a digest no reader can compare.
--
-- Additive only. No existing table or column changes; no backfill (no evidence
-- was recorded anywhere this could be recovered from). ON DELETE CASCADE with
-- tasks, as task_redactions: the activity_log row written in the same
-- transaction (action 'task:evidence_attached', task_id SET NULL on delete) is
-- the audit record that outlives the task. ON DELETE RESTRICT on the agent: an
-- attachment whose author had been deleted would be evidence nobody attached.

CREATE TABLE public.task_evidence_attachments (
    id UUID NOT NULL DEFAULT uuid_generate_v4(),
    task_id UUID NOT NULL,
    uri VARCHAR(2048) NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    content_type VARCHAR(128) NOT NULL,
    created_by_agent_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT task_evidence_attachments_pkey PRIMARY KEY (id),
    CONSTRAINT task_evidence_attachments_task_sha256_unique UNIQUE (task_id, sha256),
    CONSTRAINT task_evidence_attachments_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT task_evidence_attachments_uri_check CHECK (length(uri) > 0),
    CONSTRAINT task_evidence_attachments_content_type_check CHECK (length(content_type) > 0),
    CONSTRAINT task_evidence_attachments_task_fkey FOREIGN KEY (task_id)
        REFERENCES public.tasks(id) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT task_evidence_attachments_agent_fkey FOREIGN KEY (created_by_agent_id)
        REFERENCES public.agents(id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX idx_task_evidence_attachments_task_id
    ON public.task_evidence_attachments(task_id);

COMMENT ON TABLE public.task_evidence_attachments IS
  'A2-274 WorkItemEvidenceAttachment/v1: an artefact (uri + sha256 + content_type) an executing agent attached to a work item. The digest is the identity: UNIQUE (task_id, sha256).';
