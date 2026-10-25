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
- Ordinary users access board content through `board_members`, including cross-organisation guests.
  Workspace and organisation admin authority materializes pinned board memberships; organisation
  owners/admins also have an explicit access override. Workspace membership alone does not grant board access.
- A user can belong to multiple organisations through `client_members`; email is globally unique.
  `users.clientId` remains the original storage/media anchor, while `activeClientId` selects the default organisation.
- Onboarding runs when `me.hasWorkspace === false`.
- Every user-facing string is translated (en-US, en-GB source, es, pt-BR, fr, de, ja, nl, nb, zh-CN, zh-TW). The account's
  `users.locale` decides the language of the web app, emails and push.
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
pnpm i18n:extract              # after changing web UI text; then translate (apps/web/src/locale/README.md)
```

- `pnpm lint` also runs `pnpm i18n:check`: changed web copy fails lint until every language has
  it. Server copy (emails, push, API errors) lives in `apps/api/src/lib/i18n/`, typed so a missing
  translation fails `tsc`.
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

## Work assigned through Kanera cards

When the user asks you to carry out a specific Kanera card, keep the card updated as part of the
assignment. Use the connected Kanera skill/instructions: read the card and relevant comments,
record the original list ID/name/meaning, check for another live agent run, start your run before
substantive work, and move to the board's
actual active list. Update progress at milestones and at least every ten minutes. On a blocker,
record what is needed in both the run and a card comment, and use the appropriate waiting list.

Before your final reply, post an outcome comment with changes, verification results, relevant
PR/commit/artifact links, and remaining work; end the run appropriately. Before moving the card,
re-read the card and board. Consider the original list, available lists and their meanings,
completed work and remaining work; choose the list that reflects the card's actual state in this
board's workflow. Returning to the original list may be appropriate but is not automatic. Do not
assume list names or choose by list order or the in-progress flag alone. Explain the choice in the
comment. If unclear, leave the list unchanged, save other tracking and ask. A successful run may
cover only part of a card; complete the card only when the agreed workflow permits it and its
criteria are met. Verify the saved comment, run status, and card list; report any failed write.
Reading or exploratory planning alone causes no tracking writes; explicit user restrictions win.
This applies to real-data work the user assigns, and does not authorise using production Kanera
for local verification or updating an unrelated card.

## Making changes

- Prefer the smallest change that preserves the existing architecture.
- Before adding complexity for speculative race conditions, security edge cases, or unlikely
  failures, explain the concrete failure mode, its likelihood, and the implementation and
  maintenance cost. Get user approval before materially expanding scope for theoretical
  robustness. Address demonstrated problems within the agreed scope directly.
- When adding or changing an API env var, update every path that forwards it: `apps/api/src/env.ts`,
  `docker-compose.yml`, `.env.full.example`, `.env.example` (if required), and `DEPLOY.md` /
  `DOKPLOY_DEPLOY.md`. Compose does not forward variables it doesn't list.
- Comment the "why" where it isn't obvious from the code: product rules, tenancy and access decisions,
  realtime fanout, notification suppression, automation side effects, coalescing, ordering. Explain
  intent and constraints, not mechanics or history.
- Add user-visible changes to `CHANGELOG.md`. Keep succinct.

## Done means

1. `pnpm lint` passes.
2. The focused tests for the touched area pass, and the commands you ran are reported.
3. UI changes were seen in a real browser (screenshot), and realtime changes have E2E coverage.
4. Shared contracts, env plumbing and email previews are updated where touched.
5. Anything skipped or failing is reported as such.
