# MUN-0084: the Muneral web app (Next.js) served at app.muneral.com via nginx -> 127.0.0.1:3501.
# Build context is the REPO ROOT (see docker-compose.prod.yml): the web depends on @muneral/types.
FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS builder
WORKDIR /app

# Node 26+ official images no longer ship corepack. Same pinning as apps/api/Dockerfile.
RUN npm install --global corepack@0.36.0 \
  && corepack enable \
  && corepack prepare pnpm@11.5.2 --activate

COPY .npmrc ./
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/types/package.json ./packages/types/

RUN pnpm install --frozen-lockfile

COPY . .

# NEXT_PUBLIC_* values are inlined into the browser bundle at BUILD time, so they are public by
# construction: no secret may be passed through this ARG. apps/web/lib/api/client.ts appends
# /api/v1 itself, so the value is the API ORIGIN, not the versioned base path.
ARG NEXT_PUBLIC_API_URL=https://api.muneral.com
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm --filter @muneral/types build
RUN pnpm --filter @muneral/web build

# ---- production image ----
FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS production
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Inside a container the published port only works if the server listens on every interface;
# the host side is pinned to 127.0.0.1 in docker-compose.prod.yml.
ENV HOSTNAME=0.0.0.0

# Every COPY below sets --chown=node:node: the image must not depend on the umask of whoever
# checked the repo out on the deploy host (mode 600 files owned by root are unreadable by USER node).
# `next start` needs the workspace node_modules (pnpm symlinks into .pnpm), the build output,
# the config file and the transpiled workspace package. Same whole-tree copy as the API image.
COPY --from=builder --chown=node:node /app/.npmrc /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/apps/web/package.json /app/apps/web/next.config.ts /app/apps/web/tsconfig.json ./apps/web/
COPY --from=builder --chown=node:node /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=builder --chown=node:node /app/apps/web/.next ./apps/web/.next
COPY --from=builder --chown=node:node /app/packages/types ./packages/types

WORKDIR /app/apps/web
EXPOSE 3501
USER node
CMD ["node_modules/.bin/next", "start", "-p", "3501"]
