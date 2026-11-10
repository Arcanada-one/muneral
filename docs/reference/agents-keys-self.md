# GET /agents/keys/self (MUN-0072)

Agent API-key callers can read non-secret metadata for the key that authenticated
the request.

## Auth

- Bearer `mun_sk_…` only (`ApiKeyGuard`).
- The route never accepts a key id in the path or body.

## Response (allowlist)

| Field | Meaning |
|---|---|
| `id` | Calling API key id |
| `agentId` | Agent bound to that key |
| `label` | Optional operator label |
| `lastUsedAt` | Last successful auth touch (nullable) |
| `expiresAt` | Rotation grace / expiry (nullable) |
| `revokedAt` | Revocation timestamp (nullable; active keys are `null`) |
| `createdAt` | Key creation time |

Never returned: raw key, `keyHash`, `lookupHash`, or any sibling key.

## Related

- `POST /agents/keys/self/revoke` (MUN-0053) — emergency self-revoke.
- `GET /agents/me` (MUN-0071) — self agent projection (when deployed).
- Issuance remains JWT-only; this route does not enumerate keys.
