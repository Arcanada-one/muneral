# Task children collection (MUN-0070)

`GET /tasks/:taskId/children` lists every direct child of a parent
(`parentId = :taskId`), all statuses including cancelled and archived.

| Caller | Scope | Projection |
|---|---|---|
| Agent API key | `@AgentScope('task')` on the parent (assignment / create ownership) | Bodyless: `id, parentId, status, priority, actorType, createdAt, updatedAt, titleSha256` |
| Human JWT | Workspace membership on the parent | Full task rows, still filtered by `humanTaskWhere` |

Envelope:

```json
{
  "parentId": "<uuid>",
  "counted": "every direct child task of the parent (parentId match), all statuses including cancelled and archived",
  "total": 0,
  "projection": "bodyless",
  "tasks": []
}
```

This route does **not** auto-PATCH statuses. It does **not** replace the
project index grant: without parent task scope, use
`GET /tasks/project/:projectId/index` (when granted) and filter client-side by
`parentId`.
