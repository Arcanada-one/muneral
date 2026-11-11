# POST /agents/keys/self/rotate (MUN-0074)

Agent API-key callers can rotate the key that authenticated the request.

## Auth

- Bearer `mun_sk_…` only (`ApiKeyGuard`).
- The route never accepts a key id in the path or body.
- Declared before JWT `POST /agents/keys/:keyId/rotate` so `self` is not
  captured as a parametric key id (prod measured that shadowing as HTTP 401).

## Behavior

1. Creates a replacement key for the same agent (optional label preserved).
2. Sets the presenting key's `expiresAt` to now + the standard rotation grace
   window (same policy as JWT rotate).
3. Writes one `agent:api_key_self_rotated` activity row with `{ oldKeyId, newKeyId }`
   only (no hashes, no raw key).

## Response

Same shape as JWT rotate:

| Field | Meaning |
|---|---|
| `key` | New raw `mun_sk_…` (shown once) |
| `keyId` | New API key id |

Never returned: `keyHash`, `lookupHash`, sibling keys, or the old raw key.

## Related

- `POST /agents/keys/self/revoke` (MUN-0053) — emergency self-revoke.
- `POST /agents/keys/:keyId/rotate` — human JWT rotate-by-id.
- `GET /agents/keys/self` — non-secret metadata for the presenting key (when deployed).
