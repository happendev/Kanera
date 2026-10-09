Guidance for AI coding agents in this repository. `CLAUDE.md` imports this file; edit this one.
Area-specific rules live next to the code and load when you work there:
[`apps/api/AGENTS.md`](apps/api/AGENTS.md), [`apps/web/AGENTS.md`](apps/web/AGENTS.md), and
[`e2e/README.md`](e2e/README.md). Reusable procedures belong in `.agents/skills/`.

## Product

Kanera is an opinionated project management tool where every board inside a workspace shares the same
lists and custom fields.

```text
Organisation (client)
  └─ Workspace
       └─ Board
            └─ Card
```

Durable invariants. Code anywhere in the stack may rely on these, so comment at the point of use when
you do:

- Lists and custom fields are workspace-scoped, not board-scoped.
- Workspace membership grants access to every board; `board_members` grants cross-organisation guest
  access to specific boards.
- A user belongs to exactly one organisation (`clients` row) and email is globally unique.
- Onboarding runs when `me.hasWorkspace === false`.
- `KANERA_DEPLOYMENT_MODE=hosted` turns on billing, plans and tier limits; self-hosted has none. Check
  which mode a change applies to.

## Repo shape

```text
apps/api/        Fastify + Socket.IO + Drizzle; four processes (see apps/api/AGENTS.md)
apps/web/        Angular standalone app
apps/admin-web/  Internal admin console, served by the admin API
apps/mcp/        MCP tool layer over the public API
apps/cli/        `kanera` CLI; a second transport onto the MCP tool layer
packages/sdk/    `@kanera/sdk`; self-contained public API client, no workspace deps
packages/shared/ Shared schema, DTOs, and realtime event types
e2e/             Playwright end-to-end suite
```

`@kanera/shared` is the source of truth shared by server and client: `/schema` (Drizzle tables and
inferred types), `/dto` (Zod request/response schemas), `/events` (Socket.IO contracts). Change a
contract there first, then align the server and client in the same change.

## Commands

Run everything from the repo root.

```bash
pnpm dev:db                    # Postgres :5433 + Valkey :6379 in Docker
pnpm dev:db:reset:seed         # wipe, migrate and seed the dev DB (fix for a broken local DB)
pnpm dev                       # api :3000 + worker + web :4200
pnpm dev:public-api            # public API :3001 (MCP, CLI, SDK traffic)
pnpm dev:admin                 # admin API + admin-web
pnpm dev:hosted                # dev with hosted billing/plans enabled

pnpm db:generate               # after schema edits
pnpm db:migrate:local          # apply migrations to the dev DB (bare db:migrate has no DATABASE_URL)

pnpm lint                      # tsc + eslint per package, e2e typecheck, and knip
pnpm build
pnpm test:api                  # *.test.ts only
pnpm test:api:integration -- apps/api/src/modules/cards/routes.itest.ts
pnpm --filter @kanera/web test -- card-actions-menu.popover.spec.ts
pnpm test:mcp
pnpm test:mcp:integration
pnpm test:cli
pnpm test:sdk
pnpm test:e2e
pnpm email:preview
```

- `pnpm lint` includes knip, so unused exports, files and dependencies fail lint. Remove them; don't
  silence knip. Finish with zero errors and minimal warnings.
- Never pass `*.itest.ts` to `pnpm test:api`; it starts no Postgres. Integration tests use their own
  throwaway Postgres on `:55433`.
- The web test script matches bare spec filenames anywhere under `apps/web`.
- `.claude/launch.json` defines `web`, `api`, `public-api` and `worker` for the browser preview.

## Testing policy

- Prefer E2E tests as the primary verification for features: they are the only layer that exercises
  real cross-process realtime (unit/integration tests swap Valkey for a per-process mock). Every E2E
  run leaves a trace, screenshots and logs under `e2e/artifacts/`; report that path and the
  reproduction command.
- Before deleting an isolated test, name the failure it catches and confirm an E2E test covers it.
  Its signal is easy to underestimate.
- Add an isolated test only when E2E cannot reliably catch a concrete failure (a race, a pure
  function edge case). List the failure modes first, then write the test.

## Verifying UI changes

Dev servers usually already run on `:3000`/`:4200`; check before starting new ones. The browser has
no session, so sign in at `/login` with a seed user from `pnpm db:seed` (for example
`priya@kanera.test`, password from `DEV_SEED_SHARED_PASSWORD` in
`apps/api/src/scripts/seed-data.ts`; priya admins the "Development Team" workspace).
`POST :3000/auth/login` returns an `accessToken` for setup and cleanup calls. Restore anything you
toggle and delete what you create.

Screenshot at desktop and phone width; small screens and the PWA are first-class (see
`apps/web/AGENTS.md`). For writes made through MCP, the CLI or the SDK, also run `public-api` and
`worker`, or user-scoped realtime (sidebar, notifications) will never arrive.

## Boundaries

- Never point local verification at production. A Kanera MCP connector in your session may target
  `board.kanera.app`; use it only when the user asks for real-data work.
- Never edit a migration that has already been committed; generate a new one.
- Don't modify `.env` files with real secrets, commit credentials, or force-push shared branches.
- Ask before adding a dependency, a new top-level package, or a new realtime event family.

## Making changes

- Prefer the smallest change that preserves the existing architecture.
- When adding or changing an API env var, update every path that forwards it: `apps/api/src/env.ts`,
  `docker-compose.yml`, `.env.full.example`, `.env.example` (if required), and `DEPLOY.md` /
  `DOKPLOY_DEPLOY.md`. Compose does not forward variables it doesn't list.
- Comment the "why" where it isn't obvious from the code: product rules, tenancy and access decisions,
  realtime fanout, notification suppression, automation side effects, coalescing, ordering. Explain
  intent and constraints, not mechanics or history.
- Add user-visible changes to `CHANGELOG.md`.

## Done means

1. `pnpm lint` passes.
2. The focused tests for the touched area pass, and the commands you ran are reported.
3. UI changes were seen in a real browser (screenshot), and realtime changes have E2E coverage.
4. Shared contracts, env plumbing and email previews are updated where touched.
5. Anything skipped or failing is reported as such.
