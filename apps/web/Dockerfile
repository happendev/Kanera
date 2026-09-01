# Node LTS only. Even-numbered majors (22, 24, 26) are the LTS line; odd majors are "Current"
# and never become LTS. Keep this on an even major, in step with .nvmrc and engines.node.
FROM node:24.20.0-alpine AS build
# Hydrate Corepack before dependency installation so the build does not rely on an
# implicit package-manager download at the first `pnpm` invocation.
ENV COREPACK_DEFAULT_TO_LATEST=0
RUN corepack enable \
    && corepack install --global pnpm@11.5.2
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @kanera/web...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @kanera/web build

# nginx stable branch only. Stable is marked by EVEN minor versions and mainline (development)
# by odd ones, both published as plain 1.x.y-alpine tags: 1.30.x here is what nginx:stable-alpine
# resolves to, while 1.31.x is nginx:mainline-alpine. Keep this on an even minor — Dependabot is
# restricted to patch updates for nginx so it cannot cross over on its own.
FROM nginx:1.30.4-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist/web/browser /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
