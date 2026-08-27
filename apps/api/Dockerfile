FROM node:26-alpine AS builder
WORKDIR /app

# Enable corepack so pnpm is available (version comes from packageManager in package.json)
RUN corepack enable

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
FROM node:26-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

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
