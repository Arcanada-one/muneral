FROM node:22-alpine AS builder
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
FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable

# Copy workspace layout needed to resolve pnpm virtual store
COPY --from=builder /app/.npmrc ./
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/packages/types/package.json ./packages/types/

# Install production-only dependencies
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Copy generated Prisma client and query engine binaries.
# @prisma/* are hoisted to root node_modules via public-hoist-pattern in .npmrc.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Copy Prisma schema (needed at runtime by the query engine for introspection/error messages)
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma

WORKDIR /app/apps/api
EXPOSE 3500
USER node
CMD ["node", "dist/main.js"]
