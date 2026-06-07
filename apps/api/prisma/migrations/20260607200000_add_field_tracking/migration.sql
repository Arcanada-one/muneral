-- AddTable task_field_state
CREATE TABLE task_field_state (
    task_id UUID NOT NULL,
    field_name VARCHAR(64) NOT NULL,
    hash VARCHAR(64) NOT NULL,
    version BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT task_field_state_pkey PRIMARY KEY (task_id, field_name)
);

-- FK with cascade delete
ALTER TABLE task_field_state
    ADD CONSTRAINT task_field_state_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE ON UPDATE CASCADE;

-- Index for cursor queries
CREATE INDEX task_field_state_task_id_version_idx ON task_field_state(task_id, version);

-- AddTable agent_field_reads
CREATE TABLE agent_field_reads (
    agent_id UUID NOT NULL,
    task_id UUID NOT NULL,
    field_name VARCHAR(64) NOT NULL,
    last_seen_version BIGINT NOT NULL,
    last_seen_hash VARCHAR(64) NOT NULL,
    acknowledged_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT agent_field_reads_pkey PRIMARY KEY (agent_id, task_id, field_name)
);

-- FK with cascade delete on task
ALTER TABLE agent_field_reads
    ADD CONSTRAINT agent_field_reads_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE ON UPDATE CASCADE;

-- FK with cascade delete on agent
ALTER TABLE agent_field_reads
    ADD CONSTRAINT agent_field_reads_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE ON UPDATE CASCADE;
