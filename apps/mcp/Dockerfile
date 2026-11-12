# Node LTS only. Even-numbered majors (22, 24, 26) are the LTS line; odd majors are "Current"
# and never become LTS. Keep this on an even major, in step with .nvmrc and engines.node.
FROM node:24.22.3-alpine AS base
# Keep pnpm in the reusable image layer instead of downloading it on demand in
# each dependency stage.
ENV COREPACK_DEFAULT_TO_LATEST=0
RUN corepack enable \
    && corepack install --global pnpm@11.23.0
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/mcp/package.json apps/mcp/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @kanera/mcp...

FROM node:24.22.3-alpine AS runtime
# Entrypoints use node directly; package managers and their dependency trees are build-only.
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /repo
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
