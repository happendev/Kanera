FROM node:24.19.0-alpine AS base
# Keep pnpm in the reusable image layer instead of downloading it on demand in
# each dependency stage.
ENV COREPACK_DEFAULT_TO_LATEST=0
RUN corepack enable \
    && corepack install --global pnpm@11.5.2
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/mcp/package.json apps/mcp/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @kanera/mcp...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/mcp/node_modules apps/mcp/node_modules
COPY --from=deps /repo/packages/shared/node_modules packages/shared/node_modules
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/mcp apps/mcp
WORKDIR /repo/apps/mcp
EXPOSE 3002
USER node
CMD ["node", "--import", "tsx", "src/http.ts"]
