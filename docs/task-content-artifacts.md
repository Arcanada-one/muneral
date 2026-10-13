# Task-owned content artifacts

`POST /api/v1/tasks/:taskId/artifacts` uploads the actual bytes as canonical
base64 in JSON. An assigned agent key is required. The server computes SHA256,
checks an optional caller digest, stores bytes in PostgreSQL, and writes an audit
entry in the same transaction. Content revisions extend `TaskEvidenceAttachment`
with a task-owned `TaskArtifactRevision` relation; an existing matching legacy
claim is reused without rewriting its URI or its original attribution.

```json
{
  "name": "readiness.json",
  "contentType": "application/json",
  "contentBase64": "e30=",
  "sha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
}
```

For larger artifacts, `POST /tasks/:taskId/artifacts/bytes` accepts multipart
form data with one `content` file and metadata fields `name`, `contentType`, and
optional `sha256`. The server hashes the exact file bytes; the upload filename
does not select the artifact name or content type. This route uses a bounded
memory buffer, without changing the application's JSON parser limits.

Limits are 64 KiB per JSON upload, 1 MiB per byte upload, 16 MiB and 1000 stored revisions per
task, and the existing 100 KiB per HTTP JSON body. A changed body under the same name appends
a revision; retrying the same name/digest returns the same immutable revision.
A digest already registered with another content type is a conflict. The task
row lock serializes revision allocation and quota checks. The database refuses
in-place updates. Deleting a task retains the existing task-cascade semantics;
immutability does not prevent authorized task deletion.

`GET /api/v1/tasks/:taskId/artifacts?page=1` lists metadata, 100 rows per page,
with `total` and `nextPage`. Follow every page before claiming a complete list.
`GET .../artifacts/:artifactId` and `GET .../artifacts/by-sha/:sha256` return
metadata and `contentBase64`. Readback recomputes the digest and refuses corrupt
stored content. If the same bytes have multiple names, SHA lookup returns the
oldest matching revision; ID lookup selects an exact named revision.

Assigned agent keys can read content only for tasks in their workspace. Human
JWT reads use live workspace membership, supporting dashboard consumption.
The list omits the byte payload; a revision GET returns it. Content type is
metadata and never causes the API to execute or render uploaded HTML.

`POST/GET .../evidence` remain the legacy pointer-only contract. A URI and
caller-supplied digest alone do not prove byte custody. New fleet helpers must
upload content and verify exact byte/hash readback before reporting delivery.

This first delivery contains artifact storage only. Checklist writes, typed
CAS graph documents, the aggregate open-task read, fleet adoption and pointer
backfill are subsequent stages of Muneral task
`1f99b768-65e6-4afe-93e6-611db53e3366`.
