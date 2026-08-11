FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
COPY packages/types/package*.json ./packages/types/
RUN npm ci
COPY . .
RUN npm run build --workspace=packages/types && npm run build --workspace=apps/api

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/packages/types/package.json ./packages/types/
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist
RUN npm ci --omit=dev --workspace=apps/api --workspace=packages/types
WORKDIR /app/apps/api
EXPOSE 3500
USER node
CMD ["node", "dist/main.js"]
