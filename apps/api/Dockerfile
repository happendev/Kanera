FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @kanera/api...

FROM base AS admin-web-deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/admin-web/package.json apps/admin-web/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @kanera/admin-web...

FROM admin-web-deps AS admin-web-build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/admin-web apps/admin-web
# The admin app intentionally derives its design tokens from the tenant app at build time.
COPY apps/web/src/styles.scss apps/web/src/styles.scss
RUN pnpm --filter @kanera/admin-web build

FROM base AS runtime
# SMTP STARTTLS certificates are validated inside this image. Alpine does not
# provide a system trust store by default, so install one and make Node include it.
RUN apk add --no-cache ca-certificates
ENV NODE_ENV=production
ENV NODE_USE_SYSTEM_CA=1
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/api/node_modules apps/api/node_modules
COPY --from=deps /repo/packages/shared/node_modules packages/shared/node_modules
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
# Angular's application builder places browser assets in this subdirectory. Keep the runtime path
# aligned with admin-server.ts, which serves dist/admin-web relative to the API working directory.
COPY --from=admin-web-build /repo/apps/admin-web/dist/admin-web/browser apps/api/dist/admin-web
WORKDIR /repo/apps/api
EXPOSE 3000 3001 3002 3003
CMD ["pnpm", "start"]
