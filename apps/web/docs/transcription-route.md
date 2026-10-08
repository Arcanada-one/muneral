# Link a transcription to a task

Use the current Transcribator producer contract, GET /v1/jobs/:id/result?format=txt|srt|vtt|json, rather than the superseded artifact_uri Phase2 proposal. Send an optional transcriptionLink with the task creation request:

```json
{
  "projectId": "44444444-4444-4444-8444-444444444444",
  "title": "Review a synthetic transcription",
  "transcriptionLink": {
    "jobId": "11111111-1111-4111-8111-111111111111",
    "producerRoute": "https://example.invalid/v1/jobs/11111111-1111-4111-8111-111111111111/result?format=txt"
  }
}
```

The route must start with an explicit https:// authority, contain no backslashes, identify the same job and have exactly one supported format query parameter. Credentials, fragments, userinfo and signed URLs are refused. Same-scheme forms such as https:host/path, https:/host/path and slash/backslash authority normalization are refused by both API and web, rather than silently rewriting stored bytes. Accepted href bytes are preserved exactly. The descriptor is recorded in task-linked activity in the task creation transaction; GET /tasks/:id projects it back as transcriptionLink. No tables migration is required. Existing human workspace visibility and agent task authorization remain authoritative.

Task detail renders Open transcription with the exact stored producer route. The producer enforces its own JWT ownership when opened; Muneral does not relay credentials or bypass producer authentication. The browser test proves link rendering and exact href on a local built candidate, without opening the producer.

Production R2 is NOT_MEASURED. Native signed URL issuance, expiry, digest resolution and authorization mapping are separate follow-up task 0ee9e26f-8608-4cb7-9307-9901805e34a0, parent-linked to MUN-0014. Storing this descriptor does not verify artifact existence or content.

The reusable headless test is apps/web/browser/task-transcription.mjs and uses apps/api/test/support/transcription-browser-fixture.mjs. Compile API and web, supply an owned loopback PostgreSQL DATABASE_URL with synthetic role and a browser cache path. Pass --api-port, --web-port, --output and optionally --playwright-module as test CLI arguments; no product config keys are added. It uses native signAccess for a synthetic principal (60s TTL), no operator browser login, checks direct URL/hydration/reload, and tears down only its own fixture and processes. Web API origin must match the origin compiled into NEXT_PUBLIC_API_URL. Production addresses are refused by the fixture.
