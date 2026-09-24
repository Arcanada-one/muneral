/**
 * Which interface the API binds — explicitly, because the default was not.
 *
 * WHY THIS EXISTS (A2-251 §6, measured 2026-09-24 on arcana-devs). `main.ts` called
 * `app.listen(port)` with no host, so the process bound 0.0.0.0. Production is safe only by
 * accident of the publish spec in docker-compose.prod.yml (`127.0.0.1:3500:3500`); a hand-started
 * instance outside a container — which is what every dev run and every probe stand looks like —
 * answered on the tailscale mesh address of the host it ran on, where a ufw rule admits every mesh
 * peer. The narrow default belongs in the code, not in the deployment topology: a reader of the
 * compose file learned the wrong thing about the process.
 *
 * THE CONTAINER STILL NEEDS 0.0.0.0. Inside a container, loopback is the container's own loopback,
 * and a published port reaches the container through its bridge address — a process bound to
 * 127.0.0.1 there is unreachable from outside while STILL answering the in-container healthcheck
 * (`wget http://localhost:3500/health`), i.e. it would look healthy and serve nobody. So the image
 * sets `HOST=0.0.0.0` (apps/api/Dockerfile, production stage) and the code defaults to loopback.
 * That pairing is asserted by apps/api/test/deploy-bind.contract.spec.ts so a later edit to either
 * side cannot quietly separate them.
 *
 * DO NOT set HOST to a loopback address in a container environment file. See .env.example.
 */

/** The wildcard forms, spelled out so a reader knows what the permissive values look like. */
export const ANY_IPV4 = '0.0.0.0';
export const ANY_IPV6 = '::';

/**
 * The bind host from the environment, defaulting to IPv4 loopback.
 *
 * An empty or whitespace-only value is the same as unset: a deployment that renders
 * `HOST=` from an unset template variable must get the safe default, not a bind on
 * every interface because an empty string was passed through to `listen()`.
 */
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.HOST ?? '').trim();
  return raw.length > 0 ? raw : '127.0.0.1';
}

/** True when the host binds every interface — used only to label the startup log. */
export function bindsEveryInterface(host: string): boolean {
  return host === ANY_IPV4 || host === ANY_IPV6;
}
