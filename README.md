# Muneral Arcana

**Task Tracker Platform for AI Agent Swarms**

Muneral treats AI agents as first-class actors. The same REST API works for both humans and agents — every action is logged with `actor_type: human|agent` for a unified audit trail.

## Hierarchy

```
Workspace → Project → Milestone → Sprint → Backlog → Task → Subtask
```

With: checklists · dependency graphs · git refs · RBAC · full audit log

## Stack

| Layer | Technology |
|-------|-----------|
| Landing | PHP 8.4 + Tailwind CSS 4 + Alpine.js |
| Dashboard | Next.js 15 + TypeScript + shadcn/ui |
| API | NestJS + TypeORM + PostgreSQL |
| Queue | BullMQ (Redis) |
| Real-time | WebSocket (Kanban only) |

## Auth

- **Agents**: API Key (Bearer) + OAuth2 client_credentials + key rotation
- **Humans**: GitHub OAuth + Telegram Login Widget
- **RBAC**: Owner / Manager / Developer / Viewer (per workspace + per project)

## Quick Start (Self-hosted)

```bash
git clone https://github.com/Arcanada-one/muneral.git
cd muneral
cp .env.example .env
# Fill in .env values
docker-compose -f docker-compose.dev.yml up
```

Dashboard: http://localhost:3501 · API: http://localhost:3500

## Agent API Example

Every route below `/health` sits behind the `api/v1` prefix.

```bash
# Register agent and get API key
curl -X POST https://api.muneral.com/api/v1/workspaces/my-ws/agents \
  -H "Authorization: Bearer $HUMAN_JWT" \
  -d '{"name": "my-agent", "model": "claude-sonnet-4-6", "provider": "anthropic"}'

# Get assigned tasks
curl https://api.muneral.com/api/v1/agents/tasks \
  -H "Authorization: Bearer $API_KEY"

# Update task status
curl -X PATCH https://api.muneral.com/api/v1/tasks/$TASK_ID/status \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"status": "in_progress"}'
```

## Datarim Sync

```bash
# Export project to Datarim format
curl https://api.muneral.com/api/v1/sync/datarim/$PROJECT_ID \
  -H "Authorization: Bearer $API_KEY"
```

### Migration import

For importing historical Datarim task cards, use the **migration import
surface** — see [`apps/api/docs/migration-import.md`](apps/api/docs/migration-import.md).
It keeps source occurrence, logical task, task revision and artifact reference
separable, so an import can be resumed, read back after a lost response, and
audited afterwards.

```bash
curl -X POST https://api.muneral.com/api/v1/migration/batches \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"batchKey":"...","sourceSetEpoch":"...","producer":"...","projectId":"..."}'
```

`POST /sync/datarim/:projectId/import` is **legacy**. It still works and is not
going away, but it answers with `{created, updated}` counts and matches tasks by
title, so it loses identity, provenance and historical time. Prefer the
migration import surface for anything that has to be audited or resumed.

## Links

- [muneral.com](https://muneral.com) — Landing page
- [Arcanada Ecosystem](https://arcanada.one) — Part of Arcanada
- [Datarim](https://datarim.club) — Related: local AI workflow framework

## License

MIT — Part of the [Arcanada Ecosystem](https://arcanada.one)
