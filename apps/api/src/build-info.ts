/**
 * What commit this process was built from — or the reason it cannot say.
 *
 * WHY THIS EXISTS (A2-251 §5.5, measured 2026-09-24). `/health` reported only `version`, read from
 * apps/api/package.json. That manifest has said 0.4.6 since 6c9b48e, so every commit after it
 * answers with the same string: the pipeline check "the version in /health is the version of the
 * branch" passes while being unable to tell two builds apart. A deploy that silently kept the old
 * container, and a deploy that replaced it, look identical over HTTP.
 *
 * WHERE THE VALUE COMES FROM. `MUNERAL_BUILD_SHA`, baked into the image at build time:
 * docker-compose.prod.yml passes `${BUILD_SHA:-}` as a build arg, apps/api/Dockerfile turns the ARG
 * into an ENV in the production stage. Deliberately NOT read from a `.git` directory at runtime —
 * `.dockerignore` excludes `.git`, the production image has none, and a value that appears only in
 * development would make `sha: null` look like a local quirk instead of what it is.
 *
 * KNOWN HOLE, recorded rather than papered over: on arcana-prd the deploy runs through
 * `arcanada-compose-broker`, and the broker exports BUILD_SHA only for services listed in its
 * BUILDSHA table (Arcanada-one/model-connector deploy/arcanada-compose-broker.sh:234, which as of
 * 2026-09-24 lists transcribator-api only). Until muneral is listed there, `${BUILD_SHA:-}` resolves
 * empty in production and this reports `sha: null` with the problem below. That is `not_measured` —
 * never read it as a pass, and never as proof that the build is stale.
 *
 * THE SHAPE follows Model Connector's `/health` `build` field (A2-144/A2-228,
 * src/health/build-info.ts) on purpose: one vocabulary for "which commit is answering" across the
 * ecosystem's health endpoints. Muneral requires the FULL 40-hex object id, because the deploy has
 * it (`$GITHUB_SHA`) and a probe asserting a fixed width is a probe that can go red on a truncated
 * or templated value.
 */

/** Exactly a full git object id, lowercase or upper, and nothing else. */
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

export interface BuildInfo {
  /** The commit, lowercased — or null when this process cannot name it. */
  sha: string | null;
  source: 'MUNERAL_BUILD_SHA' | null;
  /** Present exactly when `sha` is null: why the build is not_measured rather than a pass. */
  problem?: string;
}

export function buildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const raw = (env.MUNERAL_BUILD_SHA ?? '').trim();
  if (raw.length === 0) {
    return {
      sha: null,
      source: null,
      problem:
        'MUNERAL_BUILD_SHA is not set, so this process cannot name the commit it was built from. ' +
        'It is baked into the image from the build arg fed by docker-compose.prod.yml; an instance ' +
        'started by hand from a working tree has no value to report. Read this as not_measured, ' +
        'never as a pass.',
    };
  }
  if (!COMMIT_SHA.test(raw)) {
    return {
      sha: null,
      source: null,
      problem:
        `MUNERAL_BUILD_SHA is not a full 40-character commit id (got ${raw.length} characters), ` +
        'so it is reported as no build rather than as one.',
    };
  }
  return { sha: raw.toLowerCase(), source: 'MUNERAL_BUILD_SHA' };
}
