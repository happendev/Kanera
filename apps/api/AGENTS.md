API rules. The root [`AGENTS.md`](../../AGENTS.md) still applies.

## Processes

`apps/api` builds four entry points that share modules:

| Entry                       | Dev command                | Role                                                   |
| --------------------------- | -------------------------- | ------------------------------------------------------ |
| `src/index.ts`              | `pnpm dev`                 | App API for the web client (:3000), Socket.IO, drains `event_outbox` |
| `src/public-api-index.ts`   | `pnpm dev:public-api`      | Public API (:3001) for MCP, CLI, SDK and API keys      |
| `src/worker-index.ts`       | `pnpm dev` (worker)        | Background jobs; drains `direct_realtime_outbox` (user-scoped events) |
| `src/admin-index.ts`        | `pnpm dev:admin`           | Admin API behind `apps/admin-web`                      |

A public-API write reaches web clients only through the outboxes, so verify cross-process behaviour
with all of app, public-api and worker running.

The code runs as ESM via `tsx`, so relative imports in `src` must end in `.js`, even in TypeScript.

## Auth and tenancy

- JWT claims are `{ sub, cid }`, where `cid` is the client (organisation) id.
- Refresh tokens are stored hashed in `refresh_tokens` and sent as the `kanera_rt` httpOnly cookie,
  scoped to `/auth`.
- Protected routes use `app.authenticate`, which populates `req.auth`.

## Mutation routes

Every mutation follows this order:

1. Validate input with the matching `@kanera/shared/dto` schema.
2. Enforce access with `assertBoardAccess(...)` or `assertWorkspaceAccess(...)`.
3. Write, then call `recordActivity(...)`, then emit the matching realtime event.

Skipping the activity write breaks the audit trail and history views. Skipping the emit leaves every
other client stale. Throw the `AppError` helpers from `src/lib/errors.ts` rather than hand-rolling
error responses.

## Realtime

- Emit with `emitToBoard(...)` / `emitToWorkspace(...)`. These also write a durable `event_outbox`
  row, which drives cross-process Socket.IO fanout and webhook delivery. Broadcast directly only
  inside the outbox dispatcher or for user/session-only events.
- Rooms: `workspace:${workspaceId}` and `board:${boardId}`. Clients join board rooms explicitly with
  `board:join`, so never treat a workspace event as board-local.
- Payloads carry full entities, not diffs. `*:moved` events also carry `prevPosition`.
- Emit rebalance events before the `*:moved` event they enable; clients apply them in order.
- When adding or changing an event, update `@kanera/shared/events` first, then the emit, then the web
  consumer. Check that the outbox and webhook scope and payload are still right.

## Positions

`lists.position`, `cards.position` and `custom_fields.position` are `numeric(20,10)` stored as
strings. Assign with `between(prev, next)`. When the gap is exhausted, use the helpers in
`src/lib/rebalance.ts`.

## Schema changes

Schema changes are TypeScript-first:

1. Edit `packages/shared/src/schema` and re-export from its index if needed.
2. Run `pnpm db:generate` and review the SQL under `apps/api/drizzle`.
3. Run `pnpm db:migrate:local`.
4. Commit the schema and its migration together. Never edit a committed migration.

Value domains:

- For application-owned finite string values, export one `as const` tuple, use
  `text("col", { enum: VALUES })` and add a named `CHECK` with `valueIn(...)` from
  `packages/shared/src/schema/_value-check.ts`. Reuse the tuple in the Zod DTOs so TypeScript,
  validation and Postgres cannot drift.
- Avoid native Postgres enums unless the vocabulary is truly immutable and ordered. Roles, states,
  kinds and UI tokens evolve.
- Keep external protocol values and durable historical vocabularies (Stripe event types, link
  providers, activity/outbox event names) as open text.
- Use a lookup table and foreign key when the values are admin-configurable, carry metadata, or have
  their own lifecycle.

## Email templates

After changing anything in `src/lib/email-templates/`, run `pnpm email:preview` and commit the
regenerated HTML in `preview/`. Register new templates in the `templates` array of
`src/scripts/generate-email-previews.ts`.
