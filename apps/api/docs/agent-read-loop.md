# Agent Read Loop — Field Change Tracking

Agents poll for task changes using three HTTP calls per cycle.

## 1. GET /tasks/:taskId/field-changes

Authenticates with API key (Bearer token). Returns per-field change status.

```http
GET /tasks/550e8400-e29b-41d4-a716-446655440000/field-changes?agentId=<agent-id>
Authorization: Bearer mun_sk_<key>
```

Response:

```json
{
  "taskId": "550e8400-...",
  "etag": "a3f2d8c...",
  "fields": [
    { "field": "title", "version": 3, "hash": "abc123...", "value": "Fix login bug", "changed": true },
    { "field": "status", "version": 2, "hash": "def456...", "value": "in_progress", "changed": false }
  ],
  "activity": {
    "field": "__activity__",
    "changed": true,
    "latestActivityId": "uuid-latest",
    "lastSeenActivityId": "uuid-prev"
  }
}
```

`changed: true` means this field has a newer version than the agent last acknowledged.

## 2. POST /tasks/:taskId/field-ack

Mark fields as read. The agent advances its watermark to the current version.

```http
POST /tasks/550e8400-e29b-41d4-a716-446655440000/field-ack
Authorization: Bearer mun_sk_<key>
Content-Type: application/json

{
  "agentId": "<agent-id>",
  "fields": [
    { "field": "title", "version": 3 },
    { "field": "__activity__", "version": 0 }
  ]
}
```

Response: `204 No Content`

`body.agentId` must equal the authenticated agent ID — mismatches return `403`.
Unrecognised field names return `400`.

## 3. GET /tasks/:taskId (ETag check)

Check if the task has changed since last fetch using the strong ETag.

```http
GET /tasks/550e8400-e29b-41d4-a716-446655440000
Authorization: Bearer <jwt>
If-None-Match: "a3f2d8c..."
```

If the field state is unchanged: `304 Not Modified` (no body).
If changed: `200 OK` with full task object and new `ETag` header.

The ETag is a SHA-256 hex digest of sorted `field:version` pairs.
