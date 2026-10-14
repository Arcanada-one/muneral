-- Reuse task-owned immutable bytes, actor audit, evidence linkage and quota.
ALTER TABLE task_artifact_revisions DROP CONSTRAINT task_artifact_revisions_kind_check;
ALTER TABLE task_artifact_revisions ADD CONSTRAINT task_artifact_revisions_kind_check
  CHECK (kind IN ('artifact', 'task_graph', 'agent_graph'));
ALTER TABLE task_artifact_revisions ADD CONSTRAINT task_graph_revision_metadata
  CHECK (kind = 'artifact' OR (name = 'graph' AND content_type = 'application/json'));
