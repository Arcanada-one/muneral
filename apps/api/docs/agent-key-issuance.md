# Per-agent `mun_sk_` issuance (MUN-0066)

How a fleet runtime obtains a **distinct** Muneral API key bound to a **distinct**
`agents` row, why that binding matters for activity attribution, and where the
plaintext may live.

This closes the measured defect that every fleet write collapsed onto one
`actorId` because many runtimes shared one `mun_sk_`.

## Why one key per runtime

Every authenticated agent write attributes activity to `req.apiKeyAgent.id`
(see `ActorInterceptor`). A shared key therefore produces a shared `actorId` on
`task:status_changed`, `comment`, and every other activity row. Competing lanes
become indistinguishable in `activity_log`.

| Rule | Meaning |
|---|---|
| One runtime → one `agents` row → one active `mun_sk_` | Attribution is per runtime |
| Do not reuse a key across orchestrators, workers, or hosts | Collapse returns |
| Do not put plaintext keys in git, briefs, Muneral comments, or logs | Same store rule as Collective |

Historical rows written under a shared key are out of scope for mass
re-attribution. New writes must use the correct key.

## Who may issue

| Path | Auth | What it does |
|---|---|---|
| `POST /agents` | human JWT | Creates an `agents` row in a workspace |
| `POST /agents/:agentId/keys` | human JWT | Mints a `mun_sk_…` for that row (plaintext once) |
| `POST /agents/keys/:keyId/rotate` | human JWT | New key; old key expires after the grace window |
| `DELETE /agents/keys/:keyId` | human JWT | Hard revoke |
| `POST /agents/keys/self/revoke` | the agent key itself | Emergency self-revoke (MUN-0053) |

Agent keys **cannot** register sibling agents or mint keys for other rows.
`GET /agents` / `GET /agents/workspace/:workspaceId` stay JWT-only so a fleet
key cannot enumerate peers. Issuance is an operator / human-JWT (or the helper
script below) responsibility — the same shape as Collective admin/CLI token
create.

## Issue with the helper (preferred)

From a clone of this repository, with a short-lived human access JWT already
obtained (GitHub OAuth or Telegram Login — never an agent key):

```bash
# Write plaintext once into a protected path. The script refuses paths inside a
# git work tree and refuses to print the key to stdout when --out is set.
export MUNERAL_JWT='…'          # access_token only; do not commit
export MUNERAL_API_BASE='https://api.muneral.com/api/v1'

scripts/issue-agent-key.sh \
  --workspace-id 05f8cddf-e91f-430b-81e3-d67965aa4de3 \
  --name 'JANITOR-dev-mun-0066' \
  --label 'fleet-runtime' \
  --out /absolute/path/to/config/credentials/Muneral-agents/JANITOR-dev-mun-0066.key
```

The helper:

1. `POST /agents` with `workspaceId` + `name` (+ optional `model` / `provider`).
2. `POST /agents/:id/keys` with optional `label`.
3. Writes `keyId`, `agentId`, `name`, and the raw key to `--out` (mode `0600`).
4. Prints only non-secret identifiers to stdout (`agentId`, `keyId`, `out` path).

## Issue by hand (same routes)

```bash
API=https://api.muneral.com/api/v1
AUTH="Authorization: Bearer $MUNERAL_JWT"

# 1) agents row
curl -sS -X POST "$API/agents" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"workspaceId":"<workspace-uuid>","name":"<runtime-name>"}'
# → {"id":"<agent-uuid>", ...}

# 2) key (plaintext once)
curl -sS -X POST "$API/agents/<agent-uuid>/keys" -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"label":"<runtime-name>"}'
# → {"key":"mun_sk_…","keyId":"<key-uuid>"}
```

Redirect the JSON to a `0600` file under the protected credential store; never
paste the `key` field into chat or a Muneral comment.

## Protected credential path (Collective cross-link)

Collective (`Arcanada-one/agent-mailbox`) issues one `mbx_…` token per agent via
server CLI / optional admin API and stores the map under the workspace
gitignored credential path (`config/credentials/…`, mode `0600`), referenced by
`spaces/*/space.yml` `credentials_ref` — never in git history, issues, or logs.
See that repository's `AGENTS.md` § Credentials / Token lifecycle.

Muneral follows the **same store rule**:

| Store | Contents |
|---|---|
| Workspace `config/credentials/Muneral.md` or `Muneral-agents/<runtime>.key` | Per-runtime `mun_sk_` map (gitignored) |
| Process env / MCP client config (mode `0600`) | The single key for *this* runtime |
| Git, PR bodies, Muneral CONTENT, agent briefs | Never |

Load only your own key into the process that will call Muneral. The shared
orchestrator helper (`mun.py`) remains a qualified access path for Root tooling;
product fleet workers must not all share that same `mun_sk_` if attribution is
required.

## Measuring attribution (acceptance probe)

After two runtimes hold distinct keys bound to distinct agent ids:

1. Runtime A: `PATCH /tasks/:id/status` (allowed scope) → activity row
   `action=task:status_changed`, `actorType=agent`, `actorId=<A>`.
2. Runtime B: `POST /tasks/:id/comments` → activity row `action=comment`,
   `actorType=agent`, `actorId=<B>`.
3. `actorId` values must differ. If they match, the runtimes still share a key.

Automated proof: `apps/api/test/agent-key-attribution.e2e.spec.ts` (MUN-0066).

## Related contract

- Consumer read/write matrix for an already-issued key:
  [`agent-task-contract.md`](agent-task-contract.md)
- Status transitions: [`agent-status-transitions.md`](agent-status-transitions.md)
- Self-revoke: `POST /agents/keys/self/revoke` (MUN-0053)

## History

- **MUN-0066** — documented issuance + Collective store cross-link; e2e that two
  keys produce two `actorId`s on status and comment; helper that writes only to a
  protected path.
