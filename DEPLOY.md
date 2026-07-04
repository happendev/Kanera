# Deploy Kanera with Docker

This guide is for a standard Docker deployment using the `docker-compose.yml`
file in this repository.

For Dokploy, use [DOKPLOY_DEPLOY.md](DOKPLOY_DEPLOY.md).

## Requirements

- Docker with Docker Compose
- A domain name pointing at your server
- HTTPS in front of the web container, usually with Caddy, Traefik, nginx, or a
  cloud load balancer
- An SMTP account if you want Kanera to send email

## Services

The compose file starts seven services:

| Service | Purpose |
|---|---|
| `postgres` | PostgreSQL 18 with persistent data in `kanera_pgdata`. |
| `valkey` | Required Valkey instance for Socket.IO fanout, presence, and shared rate limits. |
| `api` | Main Kanera API and realtime server. Internal port `3000`; safe to scale. |
| `worker` | Single background worker for schedulers, realtime outbox fallback fanout, webhooks, and presence reaping. Internal port `3003`. |
| `public-api` | Public integration API. Internal port `3001`. |
| `mcp` | MCP Streamable HTTP server backed by the public API. Internal port `3002`. |
| `web` | Built Angular app served by nginx. Internal port `80`; proxies `/api/*` and `/socket.io/*` to `api`. |

The browser should connect to the `web` service. The main `api` service should
stay internal. Expose `public-api` only if you want the external integration API.
Expose `mcp` only if you want remote MCP clients to connect to Kanera over HTTP.

## Replica count

Valkey is required for every deployment. The `api` service uses the Socket.IO
Redis adapter against Valkey, Valkey-backed presence, and Valkey-backed auth
rate limits, so multiple API processes share the same realtime and abuse-control
state.

Deployments run the default shape with two `api` replicas:

```bash
docker compose up -d
```

Set `API_REPLICAS` in `.env` before deploying to change how many app API
processes Compose keeps running across restarts and redeploys:

```env
API_REPLICAS=4
```

Schema migrations run once in a dedicated one-shot `migrate` service, not in the
API replicas. `api`, `worker`, and `public-api` wait for it to finish
(`service_completed_successfully`) before starting, so scaling `api` never races
migrations and no service serves traffic before the schema is ready. On a deploy
with no pending migrations the `migrate` container is a fast no-op.

Keep exactly one `worker` service. It runs all schedulers, webhook delivery,
presence crash reaping, and the realtime outbox dispatcher. The `api` service
handles HTTP and Socket.IO only; it does not run background jobs. The
`public-api` service does not host Socket.IO and can still be scaled separately
when needed.

## Performance tuning

Each `api`, `public-api`, and `worker` service is a Node.js process with one main
event loop. Scale `api` replicas on larger machines to spread HTTP and realtime
load across cores; leave `worker` single-instance so schedulers and dispatchers
do not duplicate work. The defaults below are conservative; on a dedicated
server these are the knobs worth raising.

The defaults are safe and need no change for small deployments. The compose file
passes these through, so set them in `.env` to override.

**Database connection pools (`PG_POOL_MAX`, Compose default `20`;
`WORKER_PG_POOL_MAX`, default `5`).** This caps how many queries each process
runs against Postgres at once and is usually the first ceiling under write-heavy
load. Keep the total comfortably below Postgres `max_connections`:

```text
(API_REPLICAS × PG_POOL_MAX) + (public-api replicas × PG_POOL_MAX) + WORKER_PG_POOL_MAX + maintenance margin
```

With the bundled Compose defaults, that starts as:

```text
(API_REPLICAS × 20) + (public-api replicas × 20) + WORKER_PG_POOL_MAX + maintenance margin
```

`API_REPLICAS` is the first term, so raising it raises the connection total
linearly. When you scale `api` up, raise Postgres `max_connections` (or lower
`PG_POOL_MAX`) to keep this sum comfortably under the server limit.

**File descriptors (`ulimits.nofile`).** The realtime server holds one file
descriptor per connected WebSocket. The compose file already raises the `api`
container limit to ~1,000,000; the default of 1024 would otherwise cap you near a
thousand concurrent clients. If you run the API outside the bundled compose file,
set an equivalent `LimitNOFILE` (systemd) or `--ulimit nofile` (docker run).

**Node heap (`NODE_OPTIONS`).** Node sizes its old-space heap from available
memory, which can behave unpredictably on a very large host. Pin it explicitly,
for example `NODE_OPTIONS=--max-old-space-size=8192` for an 8 GB heap. A few GB is
plenty for tens of thousands of mostly-idle WebSocket connections; raise it only
if heap-usage logs or GC pauses say you need to.

**libuv worker pool (`UV_THREADPOOL_SIZE`, default `16` in compose).** Native
work such as Sharp, Argon2, and crypto uses libuv worker threads. This is a
separate environment variable, not a `NODE_OPTIONS` flag.

**Postgres memory.** The bundled `postgres` container ships with stock settings.
On a dedicated box, give it real cache. Add a `compose.override.yml`:

```yaml
services:
  postgres:
    command:
      - "postgres"
      - "-c"
      - "shared_buffers=8GB"
      - "-c"
      - "effective_cache_size=24GB"
      - "-c"
      - "max_connections=200"
```

Size `shared_buffers` at roughly 25% of the RAM you want Postgres to use and
`effective_cache_size` higher to reflect OS page cache. Keep `max_connections`
above the pool math above plus room for backups and maintenance.

## 1. Create your environment file

On the server, copy the example file:

```bash
cp .env.example .env
```

Edit `.env` and set these production values:

```bash
WEB_ORIGIN=https://kanera.example.com
COOKIE_DOMAIN=kanera.example.com
COOKIE_SECURE=true
KANERA_ENVIRONMENT=production

JWT_SECRET=<openssl rand -hex 32>
MEDIA_SIGNING_SECRET=<openssl rand -hex 32>
SECRETS_ENCRYPTION_KEY=<openssl rand -hex 32>
```

Optional default SMTP settings:

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USER=kanera@example.com
SMTP_PASSWORD=your-password
SMTP_FROM_EMAIL=kanera@example.com
SMTP_FROM_NAME=Kanera
SMTP_IDENTITY_DOMAIN=example.com
INTERNAL_NOTIFICATION_EMAILS=ops@example.com,founder@example.com
```

Organisation admins can override SMTP later from Kanera's organisation settings.

### Management portal

The management portal (`apps/admin-web` + the `admin-api` process) is a separate, cross-tenant admin
console for platform staff: org/user administration, ops visibility, and support access. It is bundled
in the API image but disabled by default. Enable its Compose profile and route port 3002 to the admin
domain:

```bash
COMPOSE_PROFILES=admin
```

The portal has its own identity domain, isolated from tenant accounts:

```bash
ADMIN_JWT_SECRET=<openssl rand -hex 32>   # must differ from JWT_SECRET
ADMIN_WEB_ORIGIN=https://admin.kanera.example.com
```

**First superadmin.** There is no manual insert step. On every boot, the admin server seeds exactly one
`superadmin` from `ADMIN_EMAIL`/`ADMIN_PASSWORD` if the `admin_user` table is still empty; once any
admin account exists, this is a permanent no-op regardless of what those env vars still hold. Set them
before the admin-api's first boot:

```bash
ADMIN_EMAIL=ops@example.com
ADMIN_PASSWORD=<choose a strong password>
```

If the table is empty and these are unset, the admin server boots with a locked-out console (log a
warning) rather than failing to start. After the first superadmin exists, invite further admins from
inside the console's Admins page rather than through env vars — that flow emails an accept-invite link
scoped to `ADMIN_WEB_ORIGIN`.

### Support access

Cross-tenant support access is started from the management portal. A portal admin with the
`superadmin` role opens an org in the admin console and starts a support session
(`POST /admin/orgs/:clientId/support-session` with a `reason`), which mints a short-lived token that
acts as the target org's owner and returns a `WEB_ORIGIN/support/enter#token=…` link. Every start is
recorded in both the `support_session` audit table and `admin_audit_log`. Tune the token lifetime with
`SUPPORT_SESSION_TTL_MINUTES` (default 60); there is no refresh companion, so the session expires on
its own and can be revoked from the portal. The admin server signs this tenant token, so it must be
given `JWT_SECRET` (in addition to its own `ADMIN_JWT_SECRET`) and `WEB_ORIGIN`.

```
SUPPORT_SESSION_TTL_MINUTES=60
```

Hosted SaaS billing is disabled by default. For a hosted deployment, set hosted
mode plus Stripe Checkout and webhook values:

```bash
KANERA_DEPLOYMENT_MODE=hosted
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID_PRO_MONTHLY=price_...
STRIPE_PRICE_ID_PRO_ANNUAL=price_...
# Optional: starter purchased-seat capacity for new trial orgs.
HOSTED_TRIAL_DEFAULT_SEATS=5
```

In Stripe Billing Portal, enable invoice history, payment method updates, and
subscription updates for price and quantity. Add the Pro monthly and annual
prices to the portal configuration, and set subscription update prorations to
`create_prorations` or `always_invoice` so Stripe previews charges or credits
before confirmation.

GitHub private repository previews do not need deployment-time GitHub secrets.
After deploy, an organisation admin can open **Settings -> Organisation ->
GitHub App**, enter the GitHub organisation login, and let Kanera create the
GitHub App through GitHub's manifest flow. The generated app credentials and
installation id are stored encrypted in the database.

Optional operational alerts for startup and unhandled API errors. (Slow requests
are written to the "slow request" log and shipped to Loki for per-request
drill-down; aggregate latency is alerted on by Grafana's p95 rule, so there is no
separate slow-request webhook.) A single **Slack-compatible** incoming webhook —
Slack, Zulip (its `slack_incoming` integration), Mattermost, and Discord all work:

```bash
ALERT_WEBHOOK_URL=https://hooks.slack.com/services/YOUR_WEBHOOK_PATH
# or a Zulip slack_incoming webhook:
# ALERT_WEBHOOK_URL=https://zulip.example.com/api/v1/external/slack_incoming?api_key=XXXXXXXXXXXXXXXX&stream=alerts&topic=Kanera
OPS_ALERTS_ENABLED=true
OPS_ALERT_THROTTLE_MS=300000
SLOW_REQUEST_LOG_MS=2500
```

This same webhook is reused by Grafana's alerts when the monitoring stack is
enabled — no separate alerting config.

## 2. Publish ports

The default compose file keeps services private. If you are running only Docker
on the server, add a `compose.override.yml` file:

```yaml
services:
  web:
    ports:
      - "8080:80"

  public-api:
    ports:
      - "3001:3001"

  mcp:
    ports:
      - "3002:3002"
```

Then point your HTTPS reverse proxy at:

- `http://127.0.0.1:8080` for the Kanera web app
- `http://127.0.0.1:3001` for the public API, if you use it
- `http://127.0.0.1:3002` for the MCP server, if you use it

The app API has Valkey-backed per-IP auth limits for login, signup, and password
reset. Set `API_TRUST_PROXY=true` when Node is behind a trusted reverse proxy
such as nginx, Traefik, or an ingress that sends the real client IP; leave it
`false` only when Node is directly internet-facing or directly Cloudflare-facing.
Without this, a non-Cloudflare proxy collapses all users into the proxy socket IP
and the auth limit can lock out legitimate users.

The public API has Valkey-backed rate limits for helper routes, API-key requests,
and attachment uploads. Set `PUBLIC_API_TRUST_PROXY=true` only when the service
is behind a trusted reverse proxy that sends the real client IP. When Cloudflare
is the direct peer, Kanera uses `CF-Connecting-IP` for IP rate-limit buckets
after verifying the peer is in Cloudflare's published IP ranges.

Do not expose the `api` service directly. The `web` nginx container already
forwards app API and Socket.IO traffic.

If you expose `mcp`, route the `/mcp` endpoint to the `mcp` service and require
TLS in front of it. MCP clients authenticate with workspace API keys using an
`Authorization: Bearer kanera_<env>_...` header. Set `KANERA_ENVIRONMENT=staging`
on staging so newly generated API keys use `kanera_stg_`; production uses
`kanera_live_`.

## 3. Build and start

```bash
docker compose up -d --build
```

The `api` service applies pending database migrations before it starts.

The `mcp` service depends on `public-api` and starts after the public API health
check passes.

## 4. Check the deployment

Open your web domain in a browser.

Useful checks:

```bash
docker compose ps
docker compose logs -f api
docker compose logs -f mcp
curl https://kanera.example.com/api/health
curl https://api.kanera.example.com/health
curl https://mcp.kanera.example.com/health
```

The public API health check only works if you expose `public-api`.
The MCP health check only works if you expose `mcp`.

## Upgrading

From the repository root on the server:

```bash
git pull
docker compose up -d --build api public-api mcp web
```

If a release includes new database migrations, the rebuilt `api` service applies
them before starting.

## Backups

For the bundled Postgres container:

```bash
docker compose exec -T postgres pg_dump -U kanera kanera | gzip > kanera-$(date +%F).sql.gz
```

The database lives in the `kanera_pgdata` Docker volume. Uploaded files live in
the `kanera_uploads` Docker volume. Back up both.

Deployments can also enable automated full Postgres backups to S3. The
backup worker creates a full database dump three times per day, compresses it
with gzip, encrypts it with GPG symmetric AES-256, uploads it to S3, and keeps a
rolling 14-day window:

```bash
DB_BACKUPS_ENABLED=true
DB_BACKUP_ENCRYPTION_PASSPHRASE=<openssl rand -hex 32>
DB_BACKUP_TIMES_UTC=00:15,12:15,16:45
DB_BACKUP_RETENTION_DAYS=14
DB_BACKUP_S3_PREFIX=backups/postgres
```

By default the backup worker reuses `S3_BUCKET`, `S3_REGION`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_ENDPOINT`. Set the matching
`DB_BACKUP_S3_*` variables if backups should use a different bucket, endpoint,
region, or credentials. The generated objects are full backups named like
`backups/postgres/kanera-2026-06-10-0215.sql.gz.gpg`.

## Monitoring

Every app process (`api`, `worker`, `public-api`) exposes a Prometheus `/metrics`
endpoint with HTTP request latency (by route and status), database query latency,
Postgres connection-pool saturation, and Node runtime metrics (event loop lag,
heap, GC). This is on by default, but the endpoint fails closed with `404` until
a bearer token is configured:

```bash
METRICS_TOKEN=<openssl rand -hex 32>
```

The token applies uniformly to every app process. Prometheus refuses to start
without it when the monitoring profile is enabled.

### Optional: full Grafana stack

A self-hosted **Prometheus + Grafana + Loki + Alloy** stack plus exporters
(`postgres-exporter`, `cadvisor`, `node-exporter`, `redis-exporter`) ships in the
same compose file behind the `monitoring` profile, so it is off unless you opt in.
Budget roughly **0.7–1.5 GB RAM** for it.

Enable it in `.env`:

```bash
COMPOSE_PROFILES=monitoring
GRAFANA_ADMIN_PASSWORD=<choose a strong password>
METRICS_TOKEN=<openssl rand -hex 32>
ALERT_WEBHOOK_URL=<Slack-compatible incoming webhook>
# Set explicitly if your platform chooses a different Compose project name.
# Alloy uses this to filter Docker log discovery to this deployment only.
# On Dokploy the name is auto-generated (e.g. `kanera-app-ggcqgp`) — run
# `docker compose ls` on the server to find the real value.
COMPOSE_PROJECT_NAME=kanera
# Reach the dashboards over an internal WireGuard VPN (recommended, see below).
MONITORING_BIND_IP=172.30.0.102
# Optional:
PROMETHEUS_RETENTION=30d
```

Then:

```bash
docker compose --profile monitoring up -d --build
```

What you get:

- **Prometheus** scrapes all app replicas (via Docker DNS service discovery) and
  the exporters. Internal-only.
- **Grafana** with provisioned Prometheus + Loki datasources and a bundled
  "Kanera — App (RED + DB)" dashboard. Import community dashboards by ID for more
  depth: Node Exporter Full `1860`, PostgreSQL `9628`, and a cAdvisor dashboard.
- **Loki + Alloy** aggregate the app's Pino JSON logs so you can search by
  `requestId`, `userId`, route, level, and status in Grafana → Explore. Alloy filters
  discovery by `COMPOSE_PROJECT_NAME`, excluding unrelated containers on a shared host.
- **Grafana alerting** reuses the same `ALERT_WEBHOOK_URL` as the app (no separate
  config), delivered via Grafana's Slack integration (Slack and every Slack-compatible
  endpoint — Zulip's `slack_incoming`, Mattermost, ... — accept it). Starter rules
  (review and tune thresholds in the Grafana UI):
  - **App:** 5xx ratio, p95 latency, Postgres pool saturation, app service down.
  - **Meta-monitoring:** any monitoring/infra target down (exporters, Grafana, Loki,
    Alloy, Prometheus, DB, cache), **host disk space low**, Prometheus config-reload
    failure, Prometheus TSDB compaction failure, and Loki ingestion (5xx) errors.

> **Disk safety.** Prometheus is bounded by `PROMETHEUS_RETENTION_SIZE` (a real disk
> cap). Loki's filesystem store has **no** hard size cap — retention deletes by age on
> a schedule, so a burst can fill the disk before compaction runs
> ([Grafana docs](https://grafana.com/docs/loki/latest/configure/storage/)). The Loki
> config sets ingestion rate limits and frequent compaction to bound growth, and the
> **host disk-space alert** is the backstop. For high log volume, put Loki on a
> dedicated/size-capped partition or object storage. All monitoring volumes live on the
> host root filesystem by default, so a separate data disk is the cleanest hard limit.

> **Self-monitoring blind spot.** Prometheus cannot alert that *it* is down (it can't
> scrape itself when dead), and Grafana cannot send an alert that *it* is down. The
> meta-monitoring rules catch every other component, but the watchers themselves need an
> **external** check — an uptime monitor hitting Grafana/Prometheus, or a dead-man's
> switch (have Prometheus push a heartbeat to an external service that pages if it stops).

**Access over WireGuard (recommended).** Rather than put dashboards on the public
internet, publish Grafana and Prometheus only on the server's WireGuard (`wg0`)
interface — the same convention the bundled Postgres uses with `POSTGRES_BIND_IP`.
Set `MONITORING_BIND_IP` to the server's `wg0` address:

```bash
MONITORING_BIND_IP=172.30.0.102   # the server's wg0 address
# Optional if these host ports are taken:
GRAFANA_BIND_PORT=3000
PROMETHEUS_BIND_PORT=9090
```

Then from a machine on the VPN, browse to `http://172.30.0.102:3000` (Grafana) and
`http://172.30.0.102:9090` (Prometheus). Until `MONITORING_BIND_IP` is set both
bind to `127.0.0.1` only. **Never set it to `0.0.0.0` in production**, and add a
host firewall rule allowing ports `3000`/`9090` on `wg0` only. Loki, Alloy, and the
exporters stay internal-only and are reached through Grafana.

Alternatively, leave `MONITORING_BIND_IP` unset and put Grafana (container port
`3000`) behind your HTTPS reverse proxy with auth; keep Prometheus, Loki, Alloy,
and the exporters internal-only.

### pg_stat_statements

`pg_stat_statements` (top queries by total/mean time and call count — the best
tool for finding slow queries) is enabled on the bundled Postgres via
`shared_preload_libraries`. On a **brand-new** volume the extension is created
automatically by `docker/postgres/init.sql`. On an **existing** database the init
script does not re-run, so after upgrading create it once:

```bash
docker compose exec -T postgres psql -U kanera -d kanera \
  -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"
```

Then inspect slow queries directly:

```bash
docker compose exec -T postgres psql -U kanera -d kanera -c \
  "select calls, round(mean_exec_time::numeric,2) as mean_ms, query
   from pg_stat_statements order by total_exec_time desc limit 15;"
```

## Environment Reference

| Variable | Required | Notes |
|---|---|---|
| `WEB_ORIGIN` | yes | Public browser origin, for example `https://kanera.example.com`. |
| `COOKIE_DOMAIN` | yes | Cookie domain, usually the app hostname. |
| `COOKIE_SECURE` | yes | Use `true` for HTTPS deployments. |
| `JWT_SECRET` | yes | Stable random secret. Rotating it signs users out. |
| `MEDIA_SIGNING_SECRET` | yes | Stable random secret for signed media URLs. |
| `SECRETS_ENCRYPTION_KEY` | recommended | Stable random secret for encrypted stored secrets. |
| `ADMIN_JWT_SECRET` | required to run the admin-api | Stable random secret for the management portal's own sessions. Must differ from `JWT_SECRET` (enforced at startup). |
| `ADMIN_WEB_ORIGIN` | required to run the admin-api | Public origin of the admin console, for example `https://admin.kanera.example.com`. Also the CORS origin and the base for admin invite links. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | required for first boot only | Seeds exactly one `superadmin` account when `admin_user` is empty. Permanent no-op once any admin account exists — invite further admins from the console afterward. |
| `ADMIN_JWT_ACCESS_TTL` | no | Defaults to `15m`. |
| `ADMIN_JWT_REFRESH_TTL_DAYS` | no | Defaults to `7`. |
| `ADMIN_LOGIN_RATE_LIMIT_MAX` / `ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS` | no | Per-IP admin login throttle. Default `5` attempts per `300000`ms. |
| `ADMIN_TRUST_PROXY` | no | Set `true` when the admin-api sits behind a reverse proxy, so login rate limiting sees the real client IP. |
| `ADMIN_AUDIT_LOG_RETENTION_DAYS` | no | Defaults to `1095` (3 years). |
| `REDIS_URL` | yes | Valkey Redis-protocol connection URL. The bundled compose file sets this to `redis://valkey:6379/0`; API boot fails if Valkey is unavailable. |
| `API_REPLICAS` | no | Number of app API processes Compose keeps running. Defaults to `2`; raise on larger machines. Keep `worker` at `1`. |
| `PUBLIC_API_REPLICAS` | no | Number of public integration API processes Compose keeps running. Defaults to `1`; raise if external API traffic needs more capacity. |
| `MCP_REPLICAS` | no | Number of MCP server processes Compose keeps running. Defaults to `1`; raise if remote MCP traffic needs more capacity. |
| `DATABASE_SSL` | no | Defaults to `false` for the bundled Postgres container. Set `true` only for a database that requires SSL. |
| `POSTGRES_BIND_IP` | no | Host IP where the bundled Postgres port is published. Defaults to `127.0.0.1`. To access over WireGuard, set this to the server's `wg0` IP, never `0.0.0.0` for production. |
| `POSTGRES_BIND_PORT` | no | Host port for the bundled Postgres service. Defaults to `5433`, mapped to container port `5432`. |
| `PG_POOL_MAX` | no | Max concurrent DB connections per API/public-api process. Defaults to `20` in Compose. Raise to `30`–`50` on a dedicated host. See Performance tuning. |
| `WORKER_PG_POOL_MAX` | no | Max concurrent DB connections for the single worker. Defaults to `5` in compose. |
| `PG_CONNECTION_TIMEOUT_MS` | no | Wait for a free pooled connection before failing. Defaults to `5000`. |
| `PG_STATEMENT_TIMEOUT_MS` | no | Postgres kills any query exceeding this. Defaults to `30000`. |
| `NODE_OPTIONS` | no | Passed to Node. Use to pin the heap, for example `--max-old-space-size=8192`. Empty by default. See Performance tuning. |
| `UV_THREADPOOL_SIZE` | no | libuv worker-thread pool size for native work. Defaults to `16` in compose. |
| `WORKER_PORT` | no | Internal worker healthcheck port. Defaults to `3003`. |
| `REALTIME_WEBSOCKET_COMPRESSION_ENABLED` | no | Enables per-message deflate for browser Socket.IO websocket frames. Defaults to `true`. |
| `REALTIME_WEBSOCKET_COMPRESSION_THRESHOLD_BYTES` | no | Minimum websocket frame size to compress. Defaults to `1024`; raise it if API CPU is more constrained than bandwidth. |
| `JWT_ACCESS_TTL` | no | Defaults to `15m` in compose. |
| `JWT_REFRESH_TTL_DAYS` | no | Defaults to `30` in compose. |
| `SIGNUPS_ENABLED` | no | Defaults to `true`. Set `false` to close public self-signup/new organisation creation while still allowing existing organisation invite links. |
| `EMAIL_VERIFICATION_ENABLED` | no | Defaults to `false`, allowing signup, invite signup, and email changes before SMTP is configured. Set `true` only after outbound mail works. |
| `HOSTED_TRIAL_DEFAULT_SEATS` | no | Starter purchased-seat capacity for new hosted trial orgs. Defaults to `5`; keep aligned with `HOSTED_FREE_MAX_ORG_MEMBERS` unless trials should start with a smaller or larger pool. |
| `PUBLIC_API_FAILED_KEY_RATE_LIMIT_PER_MINUTE` | no | Per-IP failed `kanera_*` API-key auth throttle. Defaults to `10` in compose. |
| `MCP_SERVER_PUBLIC_URL` | no | Optional public MCP endpoint URL, for example `https://mcp.kanera.example.com/mcp`. |
| `ALERT_WEBHOOK_URL` | no | A Slack-compatible incoming webhook for operational alerts (Slack, Zulip `slack_incoming`, Mattermost, Discord, ...). Grafana reuses it for its alerts. |
| `OPS_ALERTS_ENABLED` | no | Defaults to `true`; no alerts are sent unless `ALERT_WEBHOOK_URL` is set. |
| `OPS_ALERT_THROTTLE_MS` | no | Defaults to `300000`; throttles repeated equivalent alerts. |
| `SLOW_REQUEST_LOG_MS` | no | Threshold (ms) for the "slow request" warn log shipped to Loki. Defaults to `2500`. Not an alert trigger — latency alerting is Grafana's p95 rule. |
| `METRICS_ENABLED` | no | Exposes Prometheus `/metrics` on each app process. Defaults to `true`. |
| `METRICS_TOKEN` | required when metrics are scraped | Bearer token required to scrape `/metrics`; the endpoint returns `404` when it is unset or incorrect. Prometheus refuses to start without it. Min 16 chars. |
| `COMPOSE_PROFILES` | no | Set to `monitoring` to start the Prometheus/Grafana/Loki/Alloy/exporters stack. Off by default. |
| `COMPOSE_PROJECT_NAME` | required with monitoring | Project name Alloy uses to restrict Docker log discovery to this deployment. Defaults to `kanera`. Platforms like Dokploy auto-generate a suffixed name (e.g. `kanera-app-ggcqgp`) — run `docker compose ls` on the server to find the real value and set this explicitly; wrong value = no logs in Loki. |
| `GRAFANA_ADMIN_PASSWORD` | only if monitoring enabled | Initial Grafana admin password. |
| `MONITORING_BIND_IP` | no | Host IP that Grafana and Prometheus publish on. Defaults to `127.0.0.1`. Set to the server's `wg0` address to reach dashboards over WireGuard; never `0.0.0.0` in production. |
| `GRAFANA_BIND_PORT` | no | Host port for Grafana. Defaults to `3000`. |
| `PROMETHEUS_BIND_PORT` | no | Host port for the Prometheus UI. Defaults to `9090`. |
| `PROMETHEUS_RETENTION` | no | Prometheus TSDB time retention. Defaults to `30d`. |
| `PROMETHEUS_RETENTION_SIZE` | no | Hard disk ceiling for the Prometheus TSDB (oldest blocks drop once exceeded). Defaults to `5GB`. |
| `GRAFANA_ROOT_URL` | no | Public Grafana URL; set when serving Grafana under a path/subdomain. |
| `POSTGRES_EXPORTER_DSN` | no | Postgres connection string for `postgres-exporter`. Defaults to the bundled Postgres. |
| `SMTP_HOST` | no | Default outbound SMTP host. |
| `SMTP_PORT` | no | Defaults to `587`. |
| `SMTP_SECURITY` | no | `starttls`, `tls`, or `none`. |
| `SMTP_USER` | no | SMTP username. |
| `SMTP_PASSWORD` | no | SMTP password. |
| `SMTP_FROM_EMAIL` | no | Default sender address. |
| `SMTP_FROM_NAME` | no | Defaults to `Kanera`. |
| `SMTP_IDENTITY_DOMAIN` | no | Domain used for SMTP EHLO and Message-ID headers. Defaults to `SMTP_FROM_EMAIL`'s domain; set this to your real sending domain, not `.local`. |
| `INTERNAL_NOTIFICATION_EMAILS` | no | Comma-separated internal recipients for plain-text signup and invite-acceptance alerts. Requires env SMTP. |
| `SUPPORT_SESSION_TTL_MINUTES` | no | Lifetime in minutes of a support-session token minted by the management portal (`POST /admin/orgs/:clientId/support-session`). Defaults to `60`. No refresh companion is issued. |
| `S3_REGION` | no | Enables deployment-wide S3 storage when set with bucket and credentials. |
| `S3_BUCKET` | no | S3 bucket for uploads. |
| `S3_ACCESS_KEY_ID` | no | S3 access key id. |
| `S3_SECRET_ACCESS_KEY` | no | S3 secret access key. |
| `S3_ENDPOINT` | no | S3-compatible endpoint for non-AWS providers. |
| `S3_PUBLIC_URL_PREFIX` | no | Optional CDN/public object URL prefix. |
| `DB_BACKUPS_ENABLED` | no | Set `true` to enable non-development full Postgres backups to S3. |
| `DB_BACKUP_ENCRYPTION_PASSPHRASE` | only if backups enabled | GPG symmetric encryption passphrase for database backups. Store it securely; it is required for restore. |
| `DB_BACKUP_TIMES_UTC` | no | Comma-separated UTC run times. Defaults to `00:15,12:15,16:45`. |
| `DB_BACKUP_RETENTION_DAYS` | no | Days of database backups to keep. Defaults to `14`. |
| `DB_BACKUP_S3_PREFIX` | no | S3 object prefix for database backups. Defaults to `backups/postgres`. |
| `DB_BACKUP_S3_BUCKET` | no | Optional backup bucket override. Defaults to `S3_BUCKET`. |
| `DB_BACKUP_S3_REGION` | no | Optional backup region override. Defaults to `S3_REGION`. |
| `DB_BACKUP_S3_ENDPOINT` | no | Optional backup S3-compatible endpoint override. Defaults to `S3_ENDPOINT`. |
| `DB_BACKUP_S3_ACCESS_KEY_ID` | no | Optional backup access key override. Defaults to `S3_ACCESS_KEY_ID`. |
| `DB_BACKUP_S3_SECRET_ACCESS_KEY` | no | Optional backup secret key override. Defaults to `S3_SECRET_ACCESS_KEY`. |
| `GITHUB_APP_ID` | no | GitHub App id for private repository link previews. Register one App per deployment with Setup URL `${WEB_ORIGIN}/settings/org` and read access to contents, metadata, and pull requests. Leave unset to bootstrap an App in-app instead. |
| `GITHUB_APP_SLUG` | no | GitHub App slug (the `app/<slug>` segment of its install URL). Required alongside `GITHUB_APP_ID`. |
| `GITHUB_APP_PRIVATE_KEY` | no | GitHub App private key PEM, with newlines escaped as `\n`. Required alongside `GITHUB_APP_ID`. |

## Notes

- `docker/postgres/init.sql` runs only when the Postgres volume is first created.
- PostgreSQL 18 provides `uuidv7()` natively. New rows use time-ordered UUID
  defaults.
- `COOKIE_SECURE=true` is required behind HTTPS, or refresh cookies will not work.
- If you use a managed database, set `DATABASE_URL` for `api` and `public-api`,
  set `DATABASE_SSL=true` if your provider requires SSL, and remove or ignore
  the bundled `postgres` service.
- Valkey is a hard dependency. If you replace the bundled Valkey service with a
  managed Valkey or Redis-compatible instance, set `REDIS_URL` for `api`, `public-api`, and `worker`
  and keep the dependency healthy before deploying app processes.
- The `mcp` service talks to `public-api` over `KANERA_PUBLIC_API_URL`, which is
  set to `http://public-api:3001` in the bundled compose file.
- If the required S3 variables are set, S3 takes precedence over local uploads
  and organisation-level storage settings.
