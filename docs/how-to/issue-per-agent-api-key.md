# How to issue a per-runtime Muneral API key

Fleet runtimes that share one `mun_sk_` collapse every activity row onto one
`actorId`. Issue **one key per runtime**, store it only under the protected
credential path, and never put the plaintext in git.

Full contract (routes, Collective cross-link, measurement):
[`apps/api/docs/agent-key-issuance.md`](../../apps/api/docs/agent-key-issuance.md).

## Steps

1. Obtain a short-lived **human** access JWT (GitHub OAuth or Telegram Login).
   An agent key cannot mint keys.
2. Choose a runtime name that matches the session / lane (for example
   `JANITOR-dev-mun-0066`).
3. Run the helper from a Muneral clone:

```bash
export MUNERAL_JWT='…'
scripts/issue-agent-key.sh \
  --workspace-id <workspace-uuid> \
  --name '<runtime-name>' \
  --label '<runtime-name>' \
  --out /absolute/path/to/config/credentials/Muneral-agents/<runtime-name>.key
```

4. Point only that runtime's process env / MCP config at the new key.
5. Confirm self-identity: `GET /agents/me` with the new key returns that
   runtime's `id` / `workspaceId` / `name` (MUN-0071; see
   `docs/reference/agents-me.md`).
6. Confirm attribution: status and comment activity from two runtimes must show
   two different `actorId` values.

## Collective parallel

Collective issues one `mbx_…` token per agent into `config/credentials/`
(gitignored). Muneral keys use the same store rule — see
`apps/api/docs/agent-key-issuance.md` § Protected credential path.
