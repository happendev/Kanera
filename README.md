# Kanera

Kanera is a project management application for organising work in workspaces, boards, lists, and cards. Lists, labels, and custom fields are defined at workspace level and shared by the boards in that workspace.

[Visit kanera.app](https://www.kanera.app) | [Documentation](https://www.kanera.app/docs) | [Getting Started](https://www.kanera.app/docs/getting-started) | [Pricing](https://www.kanera.app/pricing) | [Features](https://www.kanera.app/features)

## Data Model

```text
Organisation
  └─ Workspace
       └─ Board
            └─ Card
```

Workspace members can access public boards in the workspace. Private boards can further restrict access through board membership.

Board configuration is workspace-scoped: every board in a workspace uses the same lists, labels, and custom fields. This differs from tools such as Trello, where those settings are generally configured separately for each board.

## Features

- Kanban, List, Calendar, Assigned Work, and Work Done views
- Cards with comments, attachments, activity history, watchers, and assignable checklist items
- Workspace- and board-level notes
- Mentions, notifications, push notifications, and workspace activity
- Trigger-based automations
- Full-text search and filters
- REST API, webhooks, and an MCP server
- Trello and Kanera imports, with Excel and JSON exports
- Responsive web interface and installable progressive web app

## Hosted or Self-Hosted

Kanera can be used as a hosted service or deployed on your own infrastructure.

Hosted Kanera starts with a 30-day Pro trial, no card required. After that, teams can stay on Basic, upgrade to Pro, or self-host. See [Pricing](https://kanera.app/pricing) for the current plan details.

The self-hosted deployment uses the same codebase as Kanera Pro and has no per-seat charge. Operators are responsible for infrastructure, storage, maintenance, and backups.

For self-hosting:

- Standard Docker deployment: [DEPLOY.md](DEPLOY.md)
- Dokploy deployment: [DOKPLOY_DEPLOY.md](DOKPLOY_DEPLOY.md)
- Self-hosting guide: [kanera.app/docs/self-host](https://www.kanera.app/docs/self-host)

## Source Available

Kanera is source available under the [Elastic License 2.0](LICENSE). You may inspect, modify, and self-host the software for your own use. You may not provide Kanera to third parties as a hosted or managed service.

The Kanera name, logo, and brand assets are covered separately by [TRADEMARKS.md](TRADEMARKS.md).

## For Developers

This repository contains the Kanera application and supporting services.

**Stack:** Angular 21, Fastify 5, Socket.IO 4, Postgres 18, Drizzle ORM, Valkey, Docker Compose, and pnpm workspaces.

### Local Setup

Prerequisites:

- Node.js 24
- pnpm 11, usually through `corepack enable`
- Docker, for local Postgres and Valkey

Install dependencies and configure environment:

```bash
pnpm install
cp .env.example .env
```

The example file contains development defaults for Postgres on `localhost:5433` and Valkey on `localhost:6379`. Replace `JWT_SECRET` and `MEDIA_SIGNING_SECRET` with unique random values before exposing the application outside your local machine.

Start local infrastructure, run migrations, then start the app:

```bash
pnpm dev:db
pnpm db:migrate
pnpm dev
```

Open <http://localhost:4200>.

Adminer is available at <http://localhost:8080>. The public API and MCP server run separately when started with `pnpm dev:public-api` and `pnpm dev:mcp`.

To load a realistic demo workspace:

```bash
pnpm dev:db:reset:seed
```

Seed account details live in [dev-db-seed-content/README.md](dev-db-seed-content/README.md).

### Useful Commands

```bash
pnpm dev                 # api :3000 + worker :3003 + web :4200
pnpm dev:public-api      # public integration API on :3001
pnpm dev:mcp             # MCP server on :3002
pnpm dev:db              # local Postgres + Valkey + Adminer
pnpm dev:db:down         # stop local database services
pnpm db:generate         # generate Drizzle migrations
pnpm db:migrate          # apply pending migrations
pnpm build               # build the web app and type-check the other packages
pnpm lint                # type-check and lint all packages
pnpm test                # run unit and integration test suites
pnpm test:api            # API unit and route tests
pnpm test:api:integration # API integration tests with isolated Postgres
```

## Repository Layout

```text
apps/api/           Fastify API, worker, public API, migrations
apps/web/           Angular web app
apps/mcp/           MCP server for AI clients
packages/shared/    Shared schema, DTOs, events, and workspace defaults
docker/             Local and production support files
```

## Architecture Notes

- **Workspace-first model:** lists, labels, and custom fields are shared across boards. Workspace membership is the default access model; private boards can further restrict membership.
- **Realtime collaboration:** REST is the write path, Socket.IO fans out typed events to connected clients.
- **Durable events:** board- and workspace-scoped events are recorded in an outbox for cross-process realtime delivery and webhooks.
- **Public API and webhooks:** workspace API keys support integrations without exposing user credentials.
- **MCP support:** AI clients can connect to Kanera as structured project context through the MCP service.

## License

Source available under [Elastic License 2.0](LICENSE).
