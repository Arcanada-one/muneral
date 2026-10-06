# Verify the candidate API image

The API image installs frozen production dependencies in a separate empty stage. It retains the Prisma CLI, generated client, driver adapter and workspace types required by migration and runtime. Builder-only test dependencies must not appear in any final image layer or exported filesystem, including renamed files and symlink targets.

The ordinary CI job runs the query-program parser regression and filesystem verifier negative controls. Those checks do not establish that an image was built or that Prisma migration/query and HTTP health ran.

The candidate runner must independently qualify its Docker and disposable PostgreSQL 16 capability. The current verifier accepts an explicit GitHub-hosted environment and a job-owned PostgreSQL fixture with database and user `muneral_image_test` and `image_fixture`. Supply the exact checkout SHA, numeric run-attempt identity, PostgreSQL container ID and mapped port, and a fresh output directory to `scripts/ci/production-image-proof.mjs`. Do not use the production deploy broker, production credentials or a shared database as a candidate substitute.

A successful proof binds the image ID, every exported layer digest, final filesystem member inventory, symlink containment, migrations, Prisma client/adapter/types query and IPv4 health with the exact build SHA. Fixture images and containers remain scoped to the run and must be removed by their recorded identity. Preserve failures and cleanup failures. Syntax success, a frozen install, an old admission receipt or a passing build cannot replace this proof.

Source preparation remains incomplete until that candidate proof, a current supported canonical graph receipt, exact-head CI and independent final-source review are recorded. Full development dependency audit findings remain visible; production-stage isolation does not convert the development audit into a clean verdict. Deployment follows the repository's main-only CI/CD path after gated merge and requires resulting-main, deployed build identity and post-deploy verification.
