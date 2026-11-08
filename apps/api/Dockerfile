FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS builder
WORKDIR /app

# Node 26+ official images no longer ship corepack. Restore it, then honor
# packageManager (pnpm@11.5.2) from package.json as the source of truth.
RUN npm install --global corepack@0.36.0 \
  && corepack enable \
  && corepack prepare pnpm@11.5.2 --activate

# Copy workspace manifests + lockfile + .npmrc (needed for @prisma/* public-hoist-pattern)
COPY .npmrc ./
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/types/package.json ./packages/types/

# Install all dependencies (frozen — lock must match)
RUN pnpm install --frozen-lockfile

# Copy source + Prisma config (prisma.config.ts at root, schema at apps/api/prisma)
COPY . .

# Build shared types package first (API depends on @muneral/types)
RUN pnpm --filter @muneral/types build

# Generate Prisma client into node_modules (requires schema + engines)
# prisma.config.ts at repo root resolves schema: apps/api/prisma/schema.prisma
RUN pnpm --filter @muneral/api exec prisma generate

# Compile the API
RUN pnpm --filter @muneral/api build

# ---- production image ----
FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS production
WORKDIR /app
ENV NODE_ENV=production

# A2-255: the commit this image was built from, so /health can name it. Fed by
# docker-compose.prod.yml as `${BUILD_SHA:-}` (the variable the root deploy broker exports from the
# checkout it controls). Unset -> /health reports build.sha: null WITH a problem string, which is
# not_measured, never a pass — see apps/api/src/build-info.ts.
ARG MUNERAL_BUILD_SHA=
ENV MUNERAL_BUILD_SHA=$MUNERAL_BUILD_SHA

# A2-255: inside a container, binding loopback only would serve nobody through the published port
# while still answering the in-container healthcheck below — healthy and unreachable at once. The
# code defaults to 127.0.0.1 (apps/api/src/bind-host.ts); the image, which is exactly the place
# where every interface is the right answer, says so here.
ENV HOST=0.0.0.0

# Carry over the FULL builder workspace. With pnpm's non-hoisting layout the
# generated Prisma client + query-engine binaries live inside the per-workspace
# .pnpm virtual store (node_modules/.pnpm/@prisma+client@.../...), NOT in a root
# node_modules/@prisma directory — so the old per-package COPY of
# node_modules/@prisma resolved to a non-existent path and broke the build.
# Copying the whole node_modules tree (root + per-workspace, incl. symlinks into
# .pnpm) preserves the generated client and avoids a fragile prod re-install
# that pnpm cannot reproduce deterministically for a partially-built monorepo.
COPY --from=builder /app/.npmrc /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma
COPY --from=builder /app/packages/types/package.json ./packages/types/
COPY --from=builder /app/packages/types/dist ./packages/types/dist

WORKDIR /app/apps/api
EXPOSE 3500
USER node
CMD ["node", "dist/main.js"]
