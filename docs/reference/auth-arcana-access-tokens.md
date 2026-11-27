# Auth Arcana access tokens in the Muneral API

How the API authenticates a user signed in through Auth Arcana. This is the API side only: the
Auth Arcana client and resource, account linking and the web sign-in are separate changes.

## Switch

`AUTH_ARCANA_ENABLED=true` turns the path on. Any other value, or no value, leaves it off, and the
API then treats every token as it did before. A value other than `true` or `false` is reported once
at boot, by variable name. The API never needs the variable to start.

The trust values below are constants in `apps/api/src/auth/arcana/arcana-token.verifier.ts`. No
environment variable changes them.

**Do not turn the switch on yet.** Auth Arcana has to serve the client and the resource first, and
accounts have to be linkable.

## Which verifier sees a token

| Token | Verifier |
|---|---|
| `Bearer mun_sk_…` | API-key guard, unchanged |
| header `alg` is `EdDSA` and the switch is on | Auth Arcana verifier |
| everything else | legacy HS256 verifier, algorithm pinned to `HS256` |

The header is read without verification only to make this choice. A token that one verifier refuses
is not offered to the other. HTTP (`JwtAuthGuard` and the JWT branch of `JwtOrApiKeyGuard`) and the
`/kanban` WebSocket gateway make the same choice.

## Required token

| Field | Value |
|---|---|
| signature | `EdDSA`, key from `https://auth.arcanada.ai/.well-known/jwks.json` |
| header `typ` | `at+jwt` |
| `iss` | `https://auth.arcanada.ai` |
| `aud` | `urn:arcanada:muneral:api`, and no other audience |
| `scope` | contains `muneral:api` |
| `client_id` | `arc_muneral_web` |
| `sub` | the Auth Arcana user id (UUID), different from `client_id` |
| `exp` | required; 5 seconds of clock difference are allowed |

## Mapping to a local user

`auth_identity_links` maps `auth_user_id` (Auth Arcana `user.id`) to `users.id`, one to one. The
request then carries the local user, so memberships and roles work on local ids. The API creates no
user and no link in this path.

## Responses

| Case | HTTP | WebSocket |
|---|---|---|
| token refused | 401 | disconnected |
| valid token, no link | 403, `error: "auth_identity_unlinked"` | disconnected |
| signing keys cannot be obtained | 503 | disconnected |

## Signing keys

Keys are fetched on the first Auth Arcana token, never at boot, and cached for 10 minutes. An
unknown `kid` causes at most one refetch per 30 seconds after a successful fetch. While the endpoint
fails, tokens signed with a cached key keep working until the 10-minute cache ends; after that Auth
Arcana tokens get 503 until the endpoint answers again. Legacy tokens and API keys do not depend on
it.

A token revoked at Auth Arcana stays acceptable until its `exp`: the API checks it offline.

## WebSocket lifetime

The gateway disconnects a socket when its token expires. This applies to legacy tokens too. A
socket.io client does not reconnect by itself after the server disconnects it: the client has to
connect again with a fresh token.

## Legacy-use counter

The API logs, under `LegacyAuthCounter`:

```
legacy_auth_verified first_since_start surface=http
legacy_auth_verified window_http=0 window_ws=0 since_start_http=0 since_start_ws=0
```

The second line is written every 15 minutes, zeros included. It counts HTTP requests and WebSocket
connections accepted by the legacy verifier; it holds no token and no user data. API keys are not
counted. Counts are kept in memory: each restart starts again from zero and loses the window that was
not yet written. To state that legacy sign-in was unused over a period, read every window line of
every process in that period; a missing line is not a zero.

## Dependency manifest

`auth.dependencies.yaml` at the repository root declares these values.
`apps/api/test/auth-dependencies.contract.spec.ts` fails the build when the file is missing or
disagrees with the code.
