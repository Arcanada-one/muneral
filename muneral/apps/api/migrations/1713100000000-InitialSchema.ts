import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * InitialSchema — creates all Muneral Arcana tables.
 * Designed for PostgreSQL arcanada_muneral database.
 */
export class InitialSchema1713100000000 implements MigrationInterface {
  name = 'InitialSchema1713100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // UUID extension
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // users
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id"          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "github_id"   BIGINT UNIQUE,
        "telegram_id" BIGINT UNIQUE,
        "name"        VARCHAR NOT NULL,
        "avatar_url"  VARCHAR,
        "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // workspaces
    await queryRunner.query(`
      CREATE TABLE "workspaces" (
        "id"                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "slug"              VARCHAR NOT NULL UNIQUE,
        "name"              VARCHAR NOT NULL,
        "owner_id"          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "subscription_tier" VARCHAR NOT NULL DEFAULT 'free',
        "created_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // workspace_members
    await queryRunner.query(`
      CREATE TABLE "workspace_members" (
        "workspace_id" UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        "user_id"      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "role"         VARCHAR NOT NULL CHECK (role IN ('owner','manager','developer','viewer')),
        PRIMARY KEY ("workspace_id", "user_id")
      )
    `);

    // projects
    await queryRunner.query(`
      CREATE TABLE "projects" (
        "id"           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "workspace_id" UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        "slug"         VARCHAR NOT NULL,
        "name"         VARCHAR NOT NULL,
        "description"  TEXT,
        "repo_url"     VARCHAR,
        "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // milestones
    await queryRunner.query(`
      CREATE TABLE "milestones" (
        "id"         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "project_id" UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        "title"      VARCHAR NOT NULL,
        "due_date"   DATE,
        "status"     VARCHAR NOT NULL DEFAULT 'open'
      )
    `);

    // sprints
    await queryRunner.query(`
      CREATE TABLE "sprints" (
        "id"           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "project_id"   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        "milestone_id" UUID REFERENCES milestones(id) ON DELETE SET NULL,
        "name"         VARCHAR NOT NULL,
        "start_date"   DATE NOT NULL,
        "end_date"     DATE NOT NULL,
        "status"       VARCHAR NOT NULL DEFAULT 'planned'
      )
    `);

    // tasks
    await queryRunner.query(`
      CREATE TABLE "tasks" (
        "id"             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "project_id"     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        "sprint_id"      UUID REFERENCES sprints(id) ON DELETE SET NULL,
        "parent_id"      UUID REFERENCES tasks(id) ON DELETE SET NULL,
        "title"          VARCHAR NOT NULL,
        "description"    TEXT,
        "status"         VARCHAR NOT NULL DEFAULT 'todo'
                         CHECK (status IN ('todo','in_progress','review','blocked','done','cancelled')),
        "priority"       VARCHAR NOT NULL DEFAULT 'medium'
                         CHECK (priority IN ('critical','high','medium','low')),
        "due_date"       DATE,
        "estimate_hours" NUMERIC(6,2),
        "created_by_id"  UUID,
        "actor_type"     VARCHAR CHECK (actor_type IN ('human','agent')),
        "created_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // task_tags
    await queryRunner.query(`
      CREATE TABLE "task_tags" (
        "task_id" UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "tag"     VARCHAR NOT NULL,
        PRIMARY KEY ("task_id", "tag")
      )
    `);

    // task_checklists
    await queryRunner.query(`
      CREATE TABLE "task_checklists" (
        "id"         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "task_id"    UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "text"       VARCHAR NOT NULL,
        "checked"    BOOLEAN NOT NULL DEFAULT FALSE,
        "position"   INT,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // task_dependencies
    await queryRunner.query(`
      CREATE TABLE "task_dependencies" (
        "id"           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "from_task_id" UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "to_task_id"   UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "type"         VARCHAR NOT NULL
                       CHECK (type IN ('depends_on','blocks','related_to','duplicates'))
      )
    `);

    // agents
    await queryRunner.query(`
      CREATE TABLE "agents" (
        "id"           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "workspace_id" UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        "name"         VARCHAR NOT NULL,
        "model"        VARCHAR,
        "provider"     VARCHAR,
        "capabilities" JSONB NOT NULL DEFAULT '{}',
        "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // api_keys
    await queryRunner.query(`
      CREATE TABLE "api_keys" (
        "id"           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "agent_id"     UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        "key_hash"     VARCHAR NOT NULL,
        "label"        VARCHAR,
        "last_used_at" TIMESTAMPTZ,
        "expires_at"   TIMESTAMPTZ,
        "revoked_at"   TIMESTAMPTZ,
        "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // task_agents
    await queryRunner.query(`
      CREATE TABLE "task_agents" (
        "task_id"     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "agent_id"    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        "role"        VARCHAR NOT NULL CHECK (role IN ('lead','reviewer','executor')),
        "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY ("task_id", "agent_id")
      )
    `);

    // activity_log
    await queryRunner.query(`
      CREATE TABLE "activity_log" (
        "id"           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "task_id"      UUID REFERENCES tasks(id) ON DELETE SET NULL,
        "workspace_id" UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        "actor_type"   VARCHAR NOT NULL CHECK (actor_type IN ('human','agent')),
        "actor_id"     UUID NOT NULL,
        "action"       VARCHAR NOT NULL,
        "payload"      JSONB,
        "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // webhook_configs
    await queryRunner.query(`
      CREATE TABLE "webhook_configs" (
        "id"           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "workspace_id" UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        "url"          VARCHAR NOT NULL,
        "events"       VARCHAR[] NOT NULL DEFAULT '{}',
        "secret"       VARCHAR,
        "active"       BOOLEAN NOT NULL DEFAULT TRUE,
        "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // task_git_refs
    await queryRunner.query(`
      CREATE TABLE "task_git_refs" (
        "id"         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "task_id"    UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "type"       VARCHAR NOT NULL CHECK (type IN ('repo','branch','commit')),
        "url"        VARCHAR NOT NULL,
        "ref"        VARCHAR,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // usage_limits (scaffold)
    await queryRunner.query(`
      CREATE TABLE "usage_limits" (
        "workspace_id"         UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        "max_agents"           INT NOT NULL DEFAULT -1,
        "max_projects"         INT NOT NULL DEFAULT -1,
        "max_tasks_per_month"  INT NOT NULL DEFAULT -1
      )
    `);

    // Indexes for common queries
    await queryRunner.query(`CREATE INDEX idx_tasks_project_id ON tasks(project_id)`);
    await queryRunner.query(`CREATE INDEX idx_tasks_sprint_id ON tasks(sprint_id)`);
    await queryRunner.query(`CREATE INDEX idx_tasks_status ON tasks(status)`);
    await queryRunner.query(`CREATE INDEX idx_activity_log_task_id ON activity_log(task_id)`);
    await queryRunner.query(`CREATE INDEX idx_activity_log_workspace_id ON activity_log(workspace_id)`);
    await queryRunner.query(`CREATE INDEX idx_api_keys_agent_id ON api_keys(agent_id)`);
    await queryRunner.query(`CREATE INDEX idx_task_agents_agent_id ON task_agents(agent_id)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "usage_limits"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "task_git_refs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "webhook_configs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "activity_log"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "task_agents"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "api_keys"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agents"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "task_dependencies"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "task_checklists"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "task_tags"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tasks"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sprints"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "milestones"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "projects"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "workspace_members"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "workspaces"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }
}
