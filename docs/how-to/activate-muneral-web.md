# How to activate the Muneral web app (app.muneral.com)

`apps/web` is the Next.js front end served at `https://app.muneral.com`. nginx on the production host
proxies that name to `127.0.0.1:3501`. The `muneral-web` service in `docker-compose.prod.yml` is
**defined but dormant**: it sits under the compose profile `web`, so the deploy broker's default
`docker compose -p muneral -f docker-compose.prod.yml build` and `up -d` (no service argument, no
`--profile`) neither build nor start it. Merging the descriptors changes nothing on production, and
`muneral-api` (the fleet task system) is untouched.

Measure the dormancy without starting anything (a stand-in env file is enough):

```
docker compose -f docker-compose.prod.yml config --services              # muneral-api only
docker compose -f docker-compose.prod.yml --profile web config --services  # muneral-api, muneral-web
```

## 1. Environment the web needs when activated

Names only. Values live in the root-owned deploy environment on the host, never in this repository, a
pull request or a task comment.

| Variable | Read by | Kind | Where it must live |
|---|---|---|---|
| `NEXTAUTH_SECRET` | `apps/web/lib/auth/nextauth.ts` | secret, runtime | root-owned deploy env file; interpolated into the container by `docker-compose.prod.yml` (`${NEXTAUTH_SECRET:-}`, empty if undefined) |
| `GITHUB_CLIENT_ID` | `apps/web/lib/auth/nextauth.ts` | login provider setting, runtime | root-owned deploy env file; **not yet passed to the container** (add to the `muneral-web` `environment:` in PR-B) |
| `GITHUB_CLIENT_SECRET` | `apps/web/lib/auth/nextauth.ts` | secret, runtime | same as above; not yet passed to the container |
| `TELEGRAM_BOT_TOKEN` | `apps/web/lib/auth/nextauth.ts` (Telegram login check) | secret, runtime | same as above; not yet passed to the container |
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

## 2. Activation steps (PR-B)

1. Confirm the names in section 1 exist in the deploy environment, and pass the runtime ones the
   service still lacks (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`) through the
   `muneral-web` `environment:` block; add the two public build arguments if the login page needs them.
2. Remove the `profiles: [web]` line from `muneral-web` in `docker-compose.prod.yml`. From then on the
   broker's default build/up includes the web.
3. Add a `Wait for web healthy` step to the existing deploy job in `.github/workflows/ci.yml`, after
   the stack is brought up: poll `http://127.0.0.1:3501/login` every 5 s for up to 24 attempts, and
   fail the job with the broker logs otherwise. This is a workflow change, so it needs its own review.
4. Update `apps/api/test/web-deploy.contract.spec.ts`: drop the profile assertions and assert the probe
   step.
5. After the deploy, measure `https://app.muneral.com/login` from outside and confirm
   `muneral-api` `/health` is unchanged.
