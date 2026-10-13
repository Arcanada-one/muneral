CREATE TABLE task_artifact_revisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  evidence_id UUID NOT NULL REFERENCES task_evidence_attachments(id) ON DELETE CASCADE,
  kind VARCHAR(32) NOT NULL CHECK (kind = 'artifact'),
  name VARCHAR(128) NOT NULL CHECK (length(name) > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  content BYTEA NOT NULL,
  sha256 VARCHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content_type VARCHAR(128) NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 1048576 AND size_bytes = octet_length(content)),
  actor_type VARCHAR(16) NOT NULL CHECK (actor_type IN ('human','agent')),
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_id, kind, name, revision),
  UNIQUE(task_id, kind, name, sha256)
);
CREATE INDEX task_artifact_revisions_task_id_kind_sha256_idx ON task_artifact_revisions(task_id, kind, sha256);
-- No update API exists; prevent accidental in-place replacement by another writer.
CREATE FUNCTION refuse_task_artifact_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Task content revisions are immutable'; END;
$$;
CREATE TRIGGER task_artifact_immutable BEFORE UPDATE ON task_artifact_revisions
FOR EACH ROW EXECUTE FUNCTION refuse_task_artifact_update();
