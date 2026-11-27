# How to activate the Muneral web app (app.muneral.com)

`apps/web` is the Next.js front end served at `https://app.muneral.com`. nginx on the production host
proxies that name to `127.0.0.1:3501`. The `muneral-web` service in `docker-compose.prod.yml` is in the
**default** compose set (PR-B removed the `web` profile that PR-A added), so the deploy broker's
`docker compose -p muneral -f docker-compose.prod.yml build` and `up -d` build and start it together
with `muneral-api`.

List the default services without starting anything (a stand-in env file is enough):

```
docker compose -f docker-compose.prod.yml config --services   # muneral-api, muneral-web
```

## 1. Environment the web needs when activated

Names only. Values live in the root-owned deploy environment on the host, never in this repository, a
pull request or a task comment.

| Variable | Read by | Kind | Where it must live |
|---|---|---|---|
| `NEXTAUTH_SECRET` | `apps/web/lib/auth/nextauth.ts` | secret, runtime | root-owned deploy env file; interpolated into the container by `docker-compose.prod.yml` (`${NEXTAUTH_SECRET:-}`, empty if undefined) |
| `GITHUB_CLIENT_ID` | `apps/web/lib/auth/nextauth.ts` | login provider setting, runtime | root-owned deploy env file; interpolated into the container (`:-`, empty if undefined) |
| `GITHUB_CLIENT_SECRET` | `apps/web/lib/auth/nextauth.ts` | secret, runtime | same as above |
| `TELEGRAM_BOT_TOKEN` | `apps/web/lib/auth/nextauth.ts` (Telegram login check) | secret, runtime | **not passed to the container**: Telegram sign-in cannot work yet (see section 3) |
| `AUTH_TRUST_HOST` | NextAuth host trust behind the proxy | setting, runtime | set to `"true"` in the compose service |
| `NEXT_PUBLIC_API_URL` | `apps/web/lib/api/client.ts` | public, **build arg** | compose `build.args` (`https://api.muneral.com`; the client appends `/api/v1` itself) |
| `NEXT_PUBLIC_TELEGRAM_BOT_NAME` | `apps/web/app/(auth)/login/LoginForm.tsx` | public, build-time inlined | not yet a build arg; defaults to `MuneralBot` in code |
| `NEXT_PUBLIC_APP_URL` | `apps/web/app/(auth)/login/LoginForm.tsx` | public, build-time inlined | not yet a build arg; empty means a relative Telegram callback URL |

Anything with a `NEXT_PUBLIC_` prefix is inlined into the browser bundle at build time and is public by
construction: never route a secret through it.

The web container gets **no** `env_file`: the API's `.env` holds database and signing secrets that a
browser-facing process must not carry.

Check on the host by name only, without printing values, that the runtime names above exist in the
deploy env file before activating.

## 2. Before merging the activation

The broker builds and starts every default service in one command, so a web failure is not isolated
from the API:

- Build the web image from the exact head on a host with Docker, and get HTTP 200 from `/login` inside
  the running container. No CI job builds this image. If it fails in production, the broker's `build`
  step fails and the `muneral-api` deploy stops with it.
- The broker keeps a `:previous` image tag and a rollback service list for `muneral-api` only. Its next
  `build` also refuses to run when `muneral-api:latest` is not the running image. Whether a partly
  failed build can leave that state has not been measured.
- Confirm by name only, without printing values, that the runtime names in section 1 exist in the
  root-owned deploy env file.

## 3. What sign-in does (read from source, not measured in production)

- `/login` answering 200 says nothing about sign-in. With an empty `NEXTAUTH_SECRET` the page still
  renders while the `/api/auth/*` routes fail.
- GitHub needs the API route `POST /api/v1/auth/github` (proposed in pull request #473). Without it the
  web's token exchange has no handler. With it, the web and the API must use the same GitHub OAuth app,
  and that app must authorize the callback `https://app.muneral.com/api/auth/callback/github`.
- Telegram does not work: the login page has a placeholder element but loads no widget script, the
  `data-auth-url` path `/api/auth/telegram-callback` has no handler of its own, and the web and the API
  derive the verification key differently. #473 does not change this.
- The API allows browser calls from the origin in its `WEB_URL` setting, which defaults to
  `https://app.muneral.com`.

## 4. Follow-ups and measurement after deploy

1. The deploy job in `.github/workflows/ci.yml` has **no** web health step: its health wait and canary
   read only the API on port 3500, and `docker compose up -d` does not wait for health. A green deploy
   therefore does not show that the web is serving. A `Wait for web healthy` step is a separate
   workflow change with its own review.
2. After the deploy, measure `https://app.muneral.com/login` and
   `https://app.muneral.com/api/auth/session` from outside, and confirm `muneral-api` `/health`
   reports the deployed commit.
