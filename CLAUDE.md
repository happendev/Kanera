This file provides guidance to AI agents working in this repository.

## Purpose

Kanera is an opinionated project management tool where every board inside a workspace shares the same lists and custom fields.

Hierarchy:

```text
Organisation (client)
  └─ Workspace
       └─ Board
            └─ Card
```

Durable product invariants:

- Lists are workspace-scoped, not board-scoped.
- Custom fields are workspace-scoped, not board-scoped.
- Workspace members are the default permission model; `board_members` only further restrict private boards.
- A user belongs to exactly one organisation (`clients` row) and email is globally unique.
- Onboarding runs when `me.hasWorkspace === false`.

## Repo Shape

```text
apps/api/        Fastify + Socket.IO + Drizzle
apps/web/        Angular standalone app
packages/shared/ Shared schema, DTOs, and realtime event types
```

`@kanera/shared` is the shared source of truth:

- `@kanera/shared/schema` for Drizzle tables and inferred types.
- `@kanera/shared/dto` for Zod request and response schemas.
- `@kanera/shared/events` for Socket.IO event contracts.

API code runs as ESM via `tsx`, so relative imports in `apps/api/src` must end with `.js` even in TypeScript source.

## Commands

Run all commands from the repo root.

```bash
pnpm dev
pnpm dev:db
pnpm dev:db:down

pnpm db:generate
pnpm db:migrate
pnpm db:studio

pnpm build
pnpm lint
pnpm test:api
pnpm email:preview
pnpm test:api:integration
pnpm test:api:integration -- apps/api/src/modules/cards/routes.itest.ts
pnpm --filter @kanera/web test
pnpm --filter @kanera/web test -- card-actions-menu.popover.spec.ts
```

Notes:

- `pnpm build` and `pnpm lint` both run the TypeScript check.
- Lint output should finish with no errors, and warnings should be kept minimal.
- The API uses Node's built-in test runner via `pnpm test:api` for `*.test.ts` unit/route tests only.
- Do not pass `*.itest.ts` files to `pnpm test:api`; that does not start Postgres. Use `pnpm test:api:integration -- apps/api/src/path/to/file.itest.ts` for focused integration tests.
- API integration tests run against an isolated Docker Postgres on `localhost:55433` via `pnpm test:api:integration`, run migrations, then tear the database down.
- The web test script accepts optional spec filenames after `--`; bare filenames are matched anywhere under `apps/web`.
- The web tests are intentionally narrow and focus on realtime regression points.

## Backend Rules

Authentication and tenancy:

- JWT claims are `{ sub, cid }` where `cid` is the client id.
- Refresh tokens are stored hashed in `refresh_tokens` and sent as the `kanera_rt` httpOnly cookie scoped to `/auth`.
- Protected routes use `app.authenticate`, which populates `req.auth`.

For mutation routes, preserve this pattern:

1. Validate input with the matching DTO schema.
2. Enforce access with `assertBoardAccess(...)` or `assertWorkspaceAccess(...)`.
3. Perform the write, then call `recordActivity(...)` and emit the matching realtime event.

Do not skip the activity write or the emit. Missing either one causes broken audit or stale clients.
For board- and workspace-scoped events, the emit helper also publishes a durable `event_outbox` row. The app API drains that outbox for cross-process Socket.IO broadcasts and webhook delivery, which is how public API mutations update connected web clients near real time.

- Throw `AppError` helpers from `apps/api/src/lib/errors.ts` for API failures instead of hand-rolling error responses.

Realtime and ordering:

- Workspace-scoped events go to `workspace:${workspaceId}`.
- Board-scoped events go to `board:${boardId}`.
- Clients must explicitly join board rooms with `board:join`; workspace-scoped events should not be treated as board-local.
- Event payloads carry full entities, not diffs.
- `*:moved` events also include `prevPosition`.
- Rebalance events must be emitted before the corresponding `*:moved` event.
- Use `emitToBoard(...)` / `emitToWorkspace(...)` from route code. Do not bypass the outbox with direct Socket.IO broadcasts unless you are inside the outbox dispatcher or intentionally emitting user/client-only session events.

Positions:

- `lists.position`, `cards.position`, and `custom_fields.position` are `numeric(20,10)` stored as strings.
- Use `between(prev, next)` to assign a new position.
- If rebalancing is required, use the helpers in `apps/api/src/lib/rebalance.ts`.

## Schema Workflow

Schema changes are TypeScript-first:

1. Edit files under `packages/shared/src/schema`.
2. Re-export new schema from that package index if needed.
3. Run `pnpm db:generate`.
4. Review the generated SQL under `apps/api/drizzle`.
5. If there are pending migrations, run `pnpm db:migrate` against the dev database.
6. Commit schema and migration together.

## Frontend Rules

Angular patterns in this repo:

- The app is zoneless and uses `ChangeDetectionStrategy.OnPush`.
- Use signals for component state.
- Use `input()` and `output()`, not `@Input()` and `@Output()`.
- Use `inject()`, not constructor DI.
- Route params and query params are bound via `withComponentInputBinding()`, so prefer `input()` signals over subscribing to `ActivatedRoute`.
- Use `@for`, `@if`, and `@switch`, not structural directive syntax.
- Do not use `[(ngModel)]`, `[ngModel]`/`(ngModelChange)`, `[ngValue]`, or `[ngModelOptions]` with signals. Do not import `FormsModule`. Bind inputs and selects with native `[value]` + `(input)` instead:
  ```html
  <!-- string signal -->
  <input [value]="query()" (input)="query.set($any($event.target).value)" />
  <!-- number signal -->
  <input type="number" [value]="count()" (input)="count.set(+$any($event.target).value)" />
  <!-- nullable number from a select -->
  <select [value]="days() ?? ''" (input)="days.set($any($event.target).value ? +$any($event.target).value : null)">
    <option value="7">7 days</option>
    <option value="">Never</option>
  </select>
  ```
- For a `<select>` with `@for`-rendered `<option>`s, `[value]` alone won't reflect a pre-selected value (zoneless applies it before the options exist). Also add `[selected]` to every option, including any static placeholder:
  ```html
  <option value="" [selected]="!selectedId()">None</option>
  @for (item of items(); track item.id) {
  <option [value]="item.id" [selected]="item.id === selectedId()">{{ item.name }}</option>
  }
  ```
- Put async setup in `ngOnInit`, not constructors.

Implementation notes:

- `BoardState` is route-scoped and consumes workspace-level list events plus board-level card events.
- Board and Assigned Work pages share similar list/card drag, filter, and realtime patterns; when changing one, review the other for matching behavior or regressions.
- `CardDetailComponent` owns the live comment panel behavior.
- All UI icons use Tabler via the loaded webfont with `<i class="ti ti-icon-name"></i>`. Do not use Material Icons, Heroicons, Lucide, or Font Awesome. Flag inline SVG icon usage before adding it.
- Follow shadcn/ui's design language without importing it directly: neutral base colors, subtle borders, consistent radius, clean typography, minimal decoration, and consistent system styling across pages and components.

## When Editing

- Prefer the smallest change that preserves the existing architecture.
- Keep shared contracts in `packages/shared` aligned with both server and client changes.
- When adding or changing an API environment variable, update every deployment path that must pass it through: `docker-compose.yml`, `.env.example`, and relevant deployment docs such as `DEPLOY.md`/`DOKPLOY_DEPLOY.md`. Env vars parsed in `apps/api/src/env.ts` will not reach Docker services unless Compose forwards them.
- If you add or change a realtime event, update the shared event types first, then the route emit call and frontend consumer. For board/workspace events, ensure the outbox/webhook path still has the right scope and payload.
- When touching frontend realtime logic, prefer narrow regression tests around the affected state consumer.
- Add comments where the intent, product rule, side effect, ordering requirement, or non-obvious tradeoff is not clear from the code itself. Comments are especially expected around realtime fanout, notification suppression, automation side effects, tenancy/access decisions, coalescing, rebalance ordering, and other places where a future maintainer needs the "why", not just the "what".
- Do not leave tricky logic uncommented merely because it type-checks. If a change relies on an invariant from this file, a product decision, or a surprising interaction between backend and frontend state, add a short comment at the point of use.
- Keep comments useful and durable: explain intent and constraints, not line-by-line mechanics or stale implementation history.
- If you add or change an email template under `apps/api/src/lib/email-templates/`, run `pnpm email:preview` afterwards and commit the regenerated HTML files in `preview/`. Add new templates to the `templates` array in `apps/api/src/scripts/generate-email-previews.ts`.

If you need more detail, inspect the nearest implementation rather than expanding this file into a full reference manual.
