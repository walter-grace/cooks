# One image for api, worker and mcp; the compose command picks the entry point.
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.14.2 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/mcp/package.json apps/mcp/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/auth/package.json packages/auth/
COPY packages/jobs/package.json packages/jobs/
RUN pnpm install --frozen-lockfile --prod=false

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps ./apps
COPY --from=deps /app/packages ./packages
COPY . .
# Source runs through tsx (no build step), which keeps the image simple; swap for a tsc build when publishing.
EXPOSE 8080 8081
CMD ["pnpm", "--filter", "@cooks/api", "start"]
