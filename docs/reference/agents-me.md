# Agent self-identity (`GET /agents/me`) — MUN-0071

After per-runtime API keys (MUN-0066), a caller still needs to read back which
`agentId` / `workspaceId` the presenting `mun_sk_` maps to. This route is that
self-identity seam.

## Contract

- **Method / path:** `GET /api/v1/agents/me`
- **Auth:** agent API key (`ApiKeyGuard`) only — same class as `GET /agents/tasks`
- **Body:** none
- **200 projection:** `id`, `workspaceId`, `name`, `model`, `provider`,
  `createdAt`, `apiKeyId` (non-secret id of the presenting key)
- **Secrets:** never returns `keyHash`, `lookupHash`, raw key material, or
  `capabilities`
- **Enumeration:** this task does **not** add `GET /agents`; sibling agents are
  not listed

## Related

- Per-runtime key issuance: `docs/how-to/issue-per-agent-api-key.md`
- Workspace agent list (human JWT): `GET /agents/workspace/:workspaceId`
