# Self-host installer security review — 12 November 2026

This is a point-in-time review, not a guarantee that an image has no vulnerabilities. Nothing in
this review publishes the installer or changes an existing deployment.

## Remediation

- Node builders and API/MCP runtimes use `24.22.3-alpine`; builders use the repository's pinned
  `pnpm@11.23.0` rather than the older package manager baked into the previous Dockerfiles.
- API/MCP images install only production dependencies. `tsx` is explicitly a runtime dependency
  because all service and migration entrypoints execute TypeScript through it. npm, Corepack and
  Yarn are removed from these runtime images; production commands invoke `node` directly.
- Kanera runtime stages upgrade available Alpine packages. Release builds bypass the runtime
  stage cache to pick up fixes even when the upstream base tag has not changed.
- The backup image removes `gosu`, which is needed by the PostgreSQL server entrypoint but never
  by the backup command. Its PostgreSQL client major still matches the official server image.

The updated source also contains application dependency fixes that were absent from the published
`1.10.0` images; rebuilding is required to deliver them.

## Rebuilt Kanera images

The API, MCP, web and database-backup runtime images are rebuilt from this checkout for amd64
and arm64. All eight final images report **zero known vulnerabilities across all severities**.
Their scan results are recorded in `summary.json`; `verified-images.json` records the final OCI
index/config digests after verifying each scan against the built image’s ordered filesystem layers,
creation time and architecture.
The production dependency and Alpine package scans include low/medium findings and findings
without a fix; none are hidden by an ignore file.

## Remaining upstream findings

We deliberately retain the official service images rather than maintain private Caddy/PostgreSQL
builds. These findings therefore remain in the installer stack, even when all Kanera-built images
scan clean. Counts below are unique advisory IDs per image, not affected-package occurrences;
amd64 and arm64 have the same counts.

| Official image | Critical | High | Medium | Low | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| `caddy:2.11.9-alpine` | 0 | 2 | 4 | 0 | 2 |
| `postgres:18.6-alpine` | 1 | 44 | 38 | 3 | 2 |
| `valkey/valkey:9.1.3-alpine` | 0 | 0 | 1 | 0 | 0 |

Caddy's high findings are `CVE-2026-116587` in `go-jose/v3` (no fixed version reported) and
`CVE-2026-78661` in `golang.org/x/net` (fixed in 0.62.0; the official binary includes 0.60.0).
PostgreSQL's findings include Alpine Kerberos/libxslt packages and the Go standard library embedded
in `/usr/local/bin/gosu`, including critical `CVE-2025-68121`. A vulnerable Go standard library
being present does not by itself establish that the affected behavior is reachable through gosu;
this review does not claim exploitability or suppress those findings. Valkey reports medium
`CVE-2026-4738` in zlib, with a fix reported in `1.4-r0`.

The workspace dependency audit retains two moderate development-only advisories. The latest ESLint
and its config-array dependency still require minimatch 10, while the reported fix is minimatch
11.0.1. No dependency overrides are used; this lint-only tree is excluded from production images.

The other advisory is esbuild through
`drizzle-kit -> @esbuild-kit/esm-loader -> @esbuild-kit/core-utils`. The installed Drizzle Kit is
already the newest available version, and its dependency pins esbuild 0.18.20. The advisory concerns
esbuild's development server; this dependency tree is excluded from the API production image.
It is not suppressed or force-upgraded across incompatible dependency ranges.

## Verification and release policy

Scan with Trivy `0.76.2`, all severities and unfixed findings included. The database used for this
review was updated at `2026-11-12 07:01:33 UTC`. Full JSON reports, image IDs, scanner metadata,
build logs and local smoke-test evidence are under:

```text
e2e/artifacts/self-host-remediation-2026-11-12/
```

Local verification passed: `pnpm lint` (zero errors; 38 existing web warnings), `pnpm test:api`
(267 tests), `pnpm test:mcp` (87 tests), and `pnpm test:release` (19 tests). The generated release
Compose file started against new local volumes: migrations completed, all core services became
healthy, the web and API health routes returned 200, signup succeeded and an authenticated `/me`
request returned 200. The backup image successfully dumped the new database schema and validated
the compressed output. ARM64 `tsx`, Sharp image processing and Argon2 hashing were exercised under
emulation. Both final frontend images passed nginx configuration validation and served their HTML;
the browser assets are built natively while nginx targets the deployment architecture. Temporary test containers and data volumes were removed. The full Playwright suite
was not run for these packaging changes. CI workflow YAML was parsed locally; publication itself
was not run.

These local artifacts are ignored by Git; retain them with the release review if needed. Release
CI also retains JSON security artifacts for 30 days, scans both architectures by the built image
digest, and uses the same `scripts/scan-image-updates.py` gate as the weekly workflow. Release
publication is blocked only when a newer compatible stable image tag removes high/critical
findings from a pinned image, or registry/scanner errors prevent coverage. Existing findings in
built images and official-service reports do not independently block publication, even if an
upstream package fix exists. Reports remain complete; a passing gate is not a zero-CVE claim.

To reproduce an image build and scan, substituting each Dockerfile and image name:

```bash
docker buildx build --pull --no-cache-filter runtime --platform linux/amd64 --load \
  -f apps/api/Dockerfile -t kanera-api:security-review .
docker save -o /tmp/kanera-api-security.tar kanera-api:security-review
# Run Trivy 0.76.2 with its freshly downloaded vulnerability database:
trivy image --input /tmp/kanera-api-security.tar --scanners vuln \
  --format json --output /tmp/kanera-api-security.json
```

Repeat for arm64, MCP, web and backup images, and scan the three official service pins with
`trivy image --platform linux/amd64 --scanners vuln IMAGE` (also arm64). Do not use
`--ignore-unfixed` or a severity filter when generating the review reports.
