# Deploy Kanera with Dokploy

This guide walks through deploying Kanera as a Docker Compose application in
Dokploy.

## Requirements

- A Dokploy server
- A git repository containing Kanera
- DNS records pointing your domains at the Dokploy server
- An SMTP account if you want default outbound email

Recommended domains:

- `kanera.example.com` for the web app
- `api.kanera.example.com` for the public integration API
- `mcp.kanera.example.com` for the remote MCP server, if you want AI agents to connect over Streamable HTTP

## 1. Create the project

1. In Dokploy, create a new project.
2. Add a new application.
3. Choose Docker Compose as the application type.
4. Connect the Kanera git repository.
5. Set the compose file path to:

```text
docker-compose.yml
```

The compose file defines `postgres`, `valkey`, `api`, `worker`, `public-api`,
`mcp`, and `web`.

## 2. Add environment variables

In the Dokploy application's environment tab, add:

```bash
WEB_ORIGIN=https://kanera.example.com
COOKIE_DOMAIN=kanera.example.com
COOKIE_SECURE=true
KANERA_ENVIRONMENT=production
API_TRUST_PROXY=true
PUBLIC_API_TRUST_PROXY=true
API_REPLICAS=2
PUBLIC_API_REPLICAS=1
MCP_REPLICAS=1
REALTIME_WEBSOCKET_COMPRESSION_ENABLED=true
REALTIME_WEBSOCKET_COMPRESSION_THRESHOLD_BYTES=1024

JWT_SECRET=<openssl rand -hex 32>
MEDIA_SIGNING_SECRET=<openssl rand -hex 32>
SECRETS_ENCRYPTION_KEY=<openssl rand -hex 32>
```

`API_TRUST_PROXY=true` is required for the app API when browser traffic reaches
Node through Dokploy/Traefik or another trusted non-Cloudflare proxy. It lets
auth rate limits use the real client IP instead of treating every user as the
proxy.

`PUBLIC_API_TRUST_PROXY=true` does the same for the public integration API when
you expose it through a Dokploy domain, so public API rate limits use the real
client IP.

For GitHub private repository link previews, register a GitHub App for this
deployment (see the GitHub App section below) and add the three `GITHUB_APP_*`
variables. Leave them unset to instead bootstrap an App in-app via Settings →
Organisation after deploy. **Redeploy after saving any env var changes** — Dokploy
does not hot-reload running containers.

`API_PUBLIC_URL` defaults to `WEB_ORIGIN`. Set it only if signed media URLs
should use a different public origin:

```bash
API_PUBLIC_URL=https://media.kanera.example.com
```

The MCP service talks to the public API over the private Docker network by
default. Keep this internal URL unless you are running MCP outside the compose
network:

```bash
KANERA_PUBLIC_API_URL=http://public-api:3001
```

If you expose MCP publicly, set its browser/client-visible endpoint:

```bash
MCP_SERVER_PUBLIC_URL=https://mcp.kanera.example.com/mcp
```

Hosted SaaS billing is disabled by default. For a hosted deployment, add:

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

Optional SMTP defaults:

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USER=kanera@example.com
SMTP_PASSWORD=your-password
SMTP_FROM_EMAIL=kanera@example.com
SMTP_FROM_NAME=Kanera
# Optional EHLO/Message-ID domain; defaults to SMTP_FROM_EMAIL's domain.
SMTP_IDENTITY_DOMAIN=example.com
# Optional: comma-separated internal recipients for signup/invite-acceptance alerts.
INTERNAL_NOTIFICATION_EMAILS=ops@example.com,founder@example.com
# Optional: platform-operator emails allowed to start cross-tenant support sessions
# (POST /auth/support-session). Empty disables the feature. SUPPORT_SESSION_TTL_MINUTES tunes the
# minted token lifetime (default 60; no refresh companion).
SUPERADMIN_EMAILS=
SUPPORT_SESSION_TTL_MINUTES=60
# Optional: close public self-signup/new org creation while still allowing
# existing organisation invite links.
SIGNUPS_ENABLED=true
# Optional: require mailbox verification for signup, invite signup, and email changes.
# Leave false until SMTP is confirmed working.
EMAIL_VERIFICATION_ENABLED=false
```

Optional operational alerts. A single Slack-compatible incoming webhook — Slack,
Zulip (`slack_incoming`), Mattermost, and Discord all work. Grafana reuses it for
its alerts too:

```bash
ALERT_WEBHOOK_URL=https://hooks.slack.com/services/YOUR_WEBHOOK_PATH
# or a Zulip slack_incoming webhook:
# ALERT_WEBHOOK_URL=https://zulip.example.com/api/v1/external/slack_incoming?api_key=XXXXXXXXXXXXXXXX&stream=alerts&topic=Kanera
OPS_ALERTS_ENABLED=true
OPS_ALERT_THROTTLE_MS=300000
SLOW_REQUEST_LOG_MS=2500
```

Keep these values stable across redeploys. Changing `JWT_SECRET` signs users out.
Changing `MEDIA_SIGNING_SECRET` invalidates existing signed media URLs.

## 3. Deploy once

Start the first deploy from Dokploy.

After it finishes, check that the services exist and are running:

- `postgres`
- `valkey`
- `api`
- `worker`
- `public-api`
- `mcp`
- `web`

Dokploy needs this first deploy before the compose services are available in the
domain service selector.

Keep the `worker` service replica/instance count at exactly `1`; it owns all
schedulers, webhook delivery, presence crash reaping, and realtime outbox
fallback fanout. The `api` service is safe to scale vertically across cores
because Socket.IO fanout, presence, and rate limits use Valkey.

Set `API_REPLICAS` in Dokploy's environment tab to the number of app API
processes you want. The compose file uses that value directly, so Dokploy
redeploys, reloads, and container restarts keep the desired API count without a
manual post-deploy `docker compose --scale` command. If unset, it defaults to
`2`. `PUBLIC_API_REPLICAS` and `MCP_REPLICAS` work the same way for those
services and default to `1`.

The `public-api` and `mcp` services have separate scaling considerations.

## 4. Configure domains

Create a domain for the `web` service:

| Setting | Value |
|---|---|
| Domain | `kanera.example.com` |
| Service | `web` |
| Container port | `80` |
| HTTPS | Enabled |

Create a second domain for the `public-api` service if you want the integration
API:

| Setting | Value |
|---|---|
| Domain | `api.kanera.example.com` |
| Service | `public-api` |
| Container port | `3001` |
| HTTPS | Enabled |

Create a third domain for the `mcp` service if you want remote MCP clients to
connect over Streamable HTTP:

| Setting | Value |
|---|---|
| Domain | `mcp.kanera.example.com` |
| Service | `mcp` |
| Container port | `3002` |
| HTTPS | Enabled |

Do not create a public domain for the `api` service. The `web` nginx service
proxies `/api/*` (including `/api/media/*`) and `/socket.io/*` to it over the
private Docker network.

After domains are configured, check:

- `https://kanera.example.com/api/health` returns a healthy response.
- `https://api.kanera.example.com/health` returns a healthy response if the
  public API domain is configured.
- `https://mcp.kanera.example.com/health` returns a healthy response if the MCP
  domain is configured.

## 5. Configure persistence

The compose file creates two Docker volumes:

| Volume | Stores |
|---|---|
| `kanera_pgdata` | PostgreSQL data |
| `kanera_uploads` | Uploaded files |

Make sure both volumes are backed up in Dokploy. If you use a managed Postgres
database, set `DATABASE_URL` for the `api`, `worker`, and `public-api` services,
set `DATABASE_SSL=true` if your provider requires SSL, and remove the bundled
`postgres` service from your compose setup. Valkey is also a hard dependency; if
you replace the bundled Valkey service with a managed Valkey or Redis-compatible
instance, set `REDIS_URL` for `api`, `worker`, and `public-api`.

The bundled Postgres service publishes to `127.0.0.1:5433` by default. To reach
it from a development laptop over WireGuard, set `POSTGRES_BIND_IP` in Dokploy
to the server's `wg0` address and keep `POSTGRES_BIND_PORT` at `5433` unless
that port is already used:

```bash
POSTGRES_BIND_IP=172.30.0.102
POSTGRES_BIND_PORT=5433
```

Do not set `POSTGRES_BIND_IP=0.0.0.0` for production. Pair WireGuard access with
a host firewall rule that allows the database port only on `wg0`.

To use S3-compatible upload storage instead of the local `kanera_uploads`
volume, set these variables in Dokploy before deploying:

| Variable | Required | Notes |
|---|---:|---|
| `S3_REGION` | Yes | Use your provider's region, or `auto` where supported. |
| `S3_BUCKET` | Yes | Bucket used for Kanera uploads. |
| `S3_ACCESS_KEY_ID` | Yes | Access key with object read/write/delete permissions. |
| `S3_SECRET_ACCESS_KEY` | Yes | Secret key for the access key. |
| `S3_ENDPOINT` | No | Required for S3-compatible providers outside AWS. |
| `S3_PUBLIC_URL_PREFIX` | No | Optional CDN/public object URL prefix. |

When the required S3 values are configured, S3 takes precedence over
organisation-level storage settings and local disk storage.

You can also enable automated full Postgres backups to S3. The backup worker
creates a full dump three times per day, compresses it with gzip, encrypts it
with GPG symmetric AES-256, uploads it to S3, and keeps a rolling 14-day window:

```bash
DB_BACKUPS_ENABLED=true
DB_BACKUP_ENCRYPTION_PASSPHRASE=<openssl rand -hex 32>
DB_BACKUP_TIMES_UTC=00:15,12:15,16:45
DB_BACKUP_RETENTION_DAYS=14
DB_BACKUP_S3_PREFIX=backups/postgres
```

The backup service reuses the deployment-wide `S3_*` variables by default. Use
`DB_BACKUP_S3_BUCKET`, `DB_BACKUP_S3_REGION`, `DB_BACKUP_S3_ENDPOINT`,
`DB_BACKUP_S3_ACCESS_KEY_ID`, and `DB_BACKUP_S3_SECRET_ACCESS_KEY` only when
database backups should go to a separate bucket or credential set. Keep
`DB_BACKUP_ENCRYPTION_PASSPHRASE` somewhere durable outside Dokploy as well; it
is required to restore the `.sql.gz.gpg` files.

### Optional: GitHub App for link previews

To render private GitHub repository, pull request, and commit previews, register a
GitHub App for this deployment (Setup URL `${WEB_ORIGIN}/settings/org`, read
access to contents, metadata, and pull requests) and set the variables below.
Leave them unset to instead bootstrap an App from Settings > Organisation.

| Variable | Required | Notes |
|---|---:|---|
| `GITHUB_APP_ID` | No | GitHub App id. |
| `GITHUB_APP_SLUG` | No | GitHub App slug from its install URL. |
| `GITHUB_APP_PRIVATE_KEY` | No | App private key PEM with newlines escaped as `\n`. Paste as a single line — Dokploy's env editor reads one value per line, so a raw multi-line PEM will be silently truncated. Run `awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' your-key.pem` to get the correctly escaped form. |

## 6. Monitoring (optional)

Every app process registers a Prometheus `/metrics` endpoint (HTTP latency by route,
database query latency, Postgres pool saturation, Node runtime metrics). It returns
`404` unless a bearer token is configured:

```bash
METRICS_TOKEN=<openssl rand -hex 32>
```

Prometheus refuses to start without this token when the monitoring profile is enabled.

To run the bundled self-hosted observability stack (Prometheus + Grafana + Loki +
Alloy + `postgres-exporter` + `cadvisor` + `node-exporter` + `redis-exporter`),
add to the Dokploy environment tab and redeploy:

```bash
COMPOSE_PROFILES=monitoring
GRAFANA_ADMIN_PASSWORD=<choose a strong password>
METRICS_TOKEN=<openssl rand -hex 32>
ALERT_WEBHOOK_URL=<Slack-compatible incoming webhook>
# Must match the Compose project name Dokploy assigned to this application.
# Dokploy generates a name like `kanera-app-ggcqgp` (appName + random suffix) — NOT
# the bare `kanera` you might expect. Alloy uses this to filter Docker log discovery
# to containers in this deployment; wrong value = no logs in Loki.
# Discover the real value by running `docker compose ls` on the server — use the
# project name shown on the row with your app containers (running 10 or similar).
# The suffix is stable across redeploys; it only changes if you delete and recreate
# the Dokploy application, so re-verify with `docker compose ls` after recreation.
COMPOSE_PROJECT_NAME=kanera-app-ggcqgp   # replace with actual value from `docker compose ls`
# Reach the dashboards over the internal WireGuard VPN (recommended, see below).
MONITORING_BIND_IP=172.30.0.102
# Optional:
PROMETHEUS_RETENTION=30d
PROMETHEUS_RETENTION_SIZE=5GB
GRAFANA_ROOT_URL=http://172.30.0.102:3000
```

These services are gated behind the `monitoring` Compose profile, so they only
start when `COMPOSE_PROFILES=monitoring` is set. Budget roughly **0.7–1.5 GB
RAM** for the stack. Prometheus discovers and scrapes every `api`/`public-api`
replica automatically via Docker DNS, and also scrapes the monitoring stack
itself (Grafana, Loki, Alloy, exporters) so its own health is alertable.

**Disk safety.** Prometheus is capped by `PROMETHEUS_RETENTION_SIZE`. Loki's
filesystem store has **no** hard size cap — retention deletes by age, so a burst can
fill the disk before compaction
([Grafana docs](https://grafana.com/docs/loki/latest/configure/storage/)). The Loki
config applies ingestion rate limits and frequent compaction, and a host
disk-space alert is the backstop, but for high volume put the monitoring volumes on
a dedicated data disk (or Loki on object storage). The provisioned alerts cover
target-down, low disk, Prometheus reload/TSDB failures, and Loki ingestion errors.

### Reach Grafana + Prometheus over WireGuard (recommended)

Rather than expose dashboards on a public domain, publish Grafana and Prometheus
only on the server's WireGuard (`wg0`) interface — the same convention the bundled
Postgres service uses with `POSTGRES_BIND_IP`. Set `MONITORING_BIND_IP` in the
Dokploy environment tab to the server's `wg0` address:

```bash
MONITORING_BIND_IP=172.30.0.102   # the server's wg0 address
# Optional overrides if these host ports are taken:
GRAFANA_BIND_PORT=3000
PROMETHEUS_BIND_PORT=9090
```

After redeploy, browse from a machine on the VPN to:

- `http://172.30.0.102:3000` — Grafana
- `http://172.30.0.102:9090` — Prometheus (targets, ad-hoc queries)

Until `MONITORING_BIND_IP` is set, both bind to `127.0.0.1` (loopback only).
**Never set `MONITORING_BIND_IP=0.0.0.0` in production**, and pair WireGuard access
with a host firewall rule that allows ports `3000`/`9090` only on `wg0`. Loki,
Alloy, and all exporters stay internal-only (no published ports) and are reached
through Grafana.

If you would rather use a public HTTPS domain instead of the VPN, leave
`MONITORING_BIND_IP` unset and create a Dokploy domain for the `grafana` service
(container port `3000`, HTTPS enabled). In that case add a Traefik basic-auth
middleware on top of the Grafana admin password, and do **not** create domains for
`prometheus`, `loki`, `alloy`, or any exporter.

Grafana ships with provisioned datasources, a "Kanera — App (RED + DB)" dashboard,
and starter alert rules. Alerts reuse the same `ALERT_WEBHOOK_URL` as the app (no
separate config), delivered via Grafana's Slack integration — which Slack and every
Slack-compatible endpoint (Zulip's `slack_incoming`, Mattermost, ...) accept.

Import community dashboards by ID for more depth (Node Exporter
Full `1860`, PostgreSQL `9628`, cAdvisor). Logs from all containers are searchable
in Grafana → Explore (Loki) by `requestId`, `userId`, route, level, and status.

`pg_stat_statements` is preloaded on the bundled Postgres. The `postgres` volume
is already initialised, so the `CREATE EXTENSION` in `init.sql` will not re-run —
create it once after the redeploy that adds the preload:

```bash
docker compose exec -T postgres psql -U kanera -d kanera \
  -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"
```

If you use a managed Postgres instead of the bundled service, set
`POSTGRES_EXPORTER_DSN` to its connection string and ensure `pg_stat_statements`
is enabled there.

## 7. Enable auto deploys

In the application's deployment settings, leave **Trigger Type** set to the
default **On Push**. After that, pushing to the selected branch rebuilds and
redeploys Kanera automatically.

## Updates

For normal updates, push or pull the latest code and redeploy the application in
Dokploy. Dokploy rebuilds the changed services from `docker-compose.yml`.

## Troubleshooting

- If login works briefly and then users are signed out, confirm
  `COOKIE_SECURE=true`, `COOKIE_DOMAIN`, and `WEB_ORIGIN` match the public HTTPS
  domain.
- If `/api/health` fails on the web domain, confirm the domain routes to the
  `web` service on port `80`, not directly to `api`.
- If the public integration API does not respond, confirm its domain routes to
  `public-api` on port `3001`.
- If the MCP endpoint does not respond, confirm its domain routes to `mcp` on
  port `3002`, `MCP_SERVER_PUBLIC_URL` points at the public `/mcp` URL, and
  `KANERA_PUBLIC_API_URL` is `http://public-api:3001` inside compose.
- If a migration is missing, confirm the generated SQL was committed under
  `apps/api/drizzle/`, then rebuild and redeploy the `api` service.
