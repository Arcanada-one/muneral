# Existing-task contract pointer CAS

`PATCH /api/v1/tasks/:taskId/contract` accepts two required nullable fields:

```json
{"contractDigest":"sha256:<64 lowercase hex digits>","expectedContractDigest":null}
```

Authenticate using the caller's existing agent API key. The task must remain in
that agent's workspace and be created by that agent or assigned to it as an
executor. Reviewer/lead-only assignments, unrelated keys and user JWT requests
are refused with 403. This endpoint creates no assignments or credentials.

The digest comparison and current ownership predicate are part of one database
UPDATE. A stale expected digest returns 409; unauthorized tasks return 403.
Successful writes return the task row and append `task:contract_binding_set` in
the same transaction. Audit failure rolls the pointer back. A separate task GET
can confirm the stored value. Clear uses `contractDigest: null` and the exact
previous digest as `expectedContractDigest`.

This route stores a pointer. It does not validate KC2 admission, authorize a
provider/effect, revoke a contract globally, or invalidate in-flight work.
Digest-only CAS does not prevent ABA replay after clear. Replay-safe withdrawal
requires a separately verified monotonic authority/binding generation and a
consumer revocation boundary. For a receiver restricted to one project, also send `expectedProjectId` (UUID).
The same atomic UPDATE checks that project; a project move returns 409 without
a pointer write. This additional custody condition is not an admission lease
and does not solve digest-only ABA.

The accompanying PostgreSQL e2e tests cover authenticated bind, independent GET,
CAS conflict/concurrency, foreign-task refusal, creator/executor scope, rebind,
clear, strict input validation, and rollback if the audit write fails. Fixture
API keys exist only in the disposable test database; these tests are not live
KC2 admission evidence.

Conditional `GET /tasks/:id` includes the contract pointer from its response row
in its ETag. A successful bind, rebind or clear invalidates a cached pointer; an
unchanged pointer or refused/rolled-back write keeps the validator. This is
representation cache invalidation, not a binding epoch or effect-time lease.
