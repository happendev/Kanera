# Kanera

**All your team's work, in one place.**

Kanera is a fast, polished workspace for teams to plan work, track progress, document context, automate updates, and stay aligned. It brings boards, lists, assigned work, notes, custom fields, notifications, search, integrations, and AI-ready project context into one system.

[Visit kanera.app](https://kanera.app) | [Documentation](https://kanera.app/docs) | [Pricing](https://kanera.app/pricing) | [Features](https://kanera.app/features)

## Why Kanera

Most project tools make every board its own little island. Teams recreate the same lists, labels, and fields again and again, then lose the ability to see work clearly across projects.

Kanera is workspace-first. Define your workflow once at the workspace level, then every board shares the same structure. That makes cross-board planning, filtering, reporting, assigned work, automations, and team visibility much easier to keep consistent.

## What You Can Do

- **Plan visually** with Kanban, List, Calendar, Assigned Work, and Work Done views.
- **Keep structure consistent** with workspace-wide lists, labels, custom fields, and members.
- **Track work in detail** with rich cards, comments, attachments, activity history, watchers, and assignable checklists.
- **Document decisions** with notes that live next to the work they support.
- **Stay aligned** with mentions, notifications, push alerts, and workspace activity.
- **Automate updates** with trigger-based automations that keep routine changes moving.
- **Find the right thing fast** with full-text search and multi-field filtering.
- **Connect your workflow** through REST API access, webhooks, and an MCP server for AI agents.
- **Move your data** with Trello import, Kanera import, and exports to Excel or JSON.
- **Use it on the go** with a responsive, installable PWA experience.

## Hosted or Self-Hosted

Kanera is available as a hosted product and as a source-available self-hosted edition.

Hosted Kanera starts with a 30-day Pro trial, no card required. After that, teams can stay on Basic, upgrade to Pro, or self-host. See [Pricing](https://kanera.app/pricing) for the current plan details.

Self-hosted Kanera has full feature parity with hosted Kanera and no per-seat self-hosted cost. You provide and manage the infrastructure, storage, maintenance, and backups.

For self-hosting:

- Standard Docker deployment: [DEPLOY.md](DEPLOY.md)
- Dokploy deployment: [DOKPLOY_DEPLOY.md](DOKPLOY_DEPLOY.md)
- Self-hosting guide: [kanera.app/docs/self-host-getting-started](https://kanera.app/docs/self-host-getting-started)

## Source Available

Kanera is source available under the [Elastic License 2.0](LICENSE). You may inspect, modify, and self-host the software for your own use. You may not provide Kanera to third parties as a hosted or managed service.

The Kanera name, logo, and brand assets are covered separately by [TRADEMARKS.md](TRADEMARKS.md).

## For Developers

This repository contains the live Kanera source code.

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

Set at least:

- `JWT_SECRET`
- `MEDIA_SIGNING_SECRET`
- `DATABASE_URL`
- `REDIS_URL`

For local defaults, `DATABASE_URL` points to Postgres on `localhost:5433` and `REDIS_URL` points to Valkey on `localhost:6379`.

Start local infrastructure, run migrations, then start the app:

```bash
pnpm dev:db
pnpm db:migrate
pnpm dev
```

Open <http://localhost:4200>.

To load a realistic demo workspace:

```bash
pnpm dev:db:reset:seed
```

Seed account details live in [dev-db-seed-content/README.md](dev-db-seed-content/README.md).

### Useful Commands

```bash
pnpm dev                 # api :3000 + worker :3003 + web :4200
pnpm dev:public-api      # public integration API on :3001
pnpm dev:db              # local Postgres + Valkey + Adminer
pnpm dev:db:down         # stop local database services
pnpm db:generate         # generate Drizzle migrations
pnpm db:migrate          # apply pending migrations
pnpm build               # type-check all packages
pnpm lint                # same as build
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

- **Workspace-first model:** lists, labels, custom fields, and members are shared across boards in a workspace.
- **Realtime collaboration:** REST is the write path, Socket.IO fans out typed events to connected clients.
- **Durable events:** mutations write to an event outbox for realtime fallback and webhook delivery.
- **Public API and webhooks:** workspace API keys support integrations without exposing user credentials.
- **MCP support:** AI clients can connect to Kanera as structured project context through the MCP service.

## License

Source available under [Elastic License 2.0](LICENSE).
