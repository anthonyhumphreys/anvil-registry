FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile=false --ignore-scripts

FROM deps AS build
COPY packages packages
COPY apps/admin apps/admin
RUN pnpm --filter @anvil/admin... build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/apps/admin/node_modules /app/apps/admin/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/admin /app/apps/admin
EXPOSE 3000
CMD ["node", "apps/admin/dist/index.js"]
