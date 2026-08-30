# Releasing Kanera

This document covers cutting a workspace release and publishing the distributable packages:
`@kanera/cli` and `@kanera/sdk` to npm, and the MCP server metadata to the MCP registry. Deploying
the hosted application itself is documented in [DEPLOY.md](DEPLOY.md).

## What ships where

| Artefact | Registry | Version | Workflow |
| -------- | -------- | ------- | -------- |
| `@kanera/cli` | npm | workspace version (`vX.Y.Z` tags) | `publish-npm.yml` |
| `@kanera/sdk` | npm | workspace version (`vX.Y.Z` tags) | `publish-npm.yml` |
| MCP server metadata | MCP registry | independent (`mcp-vX.Y.Z` tags) | `publish-mcp.yml` |

The CLI bundles the `@kanera/mcp` tool layer with esbuild at build time, so the published tarball
has **zero runtime dependencies**. The SDK is compiled with `tsc` to plain ESM plus type
declarations and also has no runtime dependencies.

The CLI is licensed **Elastic-2.0**, matching the repository. Its bundle contains third-party
MIT/Apache-2.0/BSD/ISC code, so its build generates `dist/THIRD_PARTY_NOTICES.md` from the bundle's
metafile — every bundled package's license text ships with the executable, and the package test
fails if it goes missing.

The SDK is licensed **MIT** (`packages/sdk/LICENSE`) so that embedding it in an integrator's
application passes open-source-only dependency policies and license scanners; the server remains
Elastic-2.0, which is where the managed-service protection lives. The SDK bundles nothing, so its
own LICENSE — which npm includes in the tarball automatically — is sufficient. Both package suites (`pnpm test:cli`,
`pnpm test:sdk`) pack the real tarball and verify a clean `npm install` of it, so a broken publish
fails in CI rather than on an integrator's machine.

## Cutting a release

Releases run from `main` with a clean tree:

```bash
pnpm release
```

The script:

1. Prompts for major/minor/patch (or a manual version).
2. Rewrites the version in every workspace manifest **and** the `SDK_VERSION` User-Agent constant
   in `packages/sdk/src/client.ts` — that constant is hardcoded because the SDK also runs on
   browsers and Workers, and the SDK package test fails if it ever drifts from `package.json`.
3. Runs `pnpm install --lockfile-only`, `pnpm lint`, and `pnpm test`, rolling everything back on
   failure.
4. Commits, and optionally creates the annotated `vX.Y.Z` tag.

Then push and create the GitHub release:

```bash
git push origin main
git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes --verify-tag
```

## Publishing to npm

Publishing the `vX.Y.Z` GitHub release triggers `.github/workflows/publish-npm.yml`, which:

- refuses to run when the tag does not match the `apps/cli` and `packages/sdk` manifest versions;
- runs the MCP tool-layer tests (the CLI embeds that layer), then publishes `@kanera/sdk` and
  `@kanera/cli` — each package's `prepublishOnly` reruns its own build-pack-install suite;
- publishes with npm **provenance**, and skips any version that is already on the registry, so a
  partially failed run can simply be re-run.

It can also be started by hand from the Actions tab (`workflow_dispatch`), including with the
`dry-run` input to validate everything without publishing.

### One-time setup

1. Create the `kanera` organisation on npmjs.com (both packages are scoped `@kanera/...` and
   published with `--access public`).
2. Create a granular npm access token with **read and write** permission for the `@kanera` scope
   and store it as the `NPM_TOKEN` repository secret.
3. Provenance requires nothing extra beyond the workflow's `id-token: write` permission, but the
   repository must be public for the attestation link to resolve.

### Manual publish (fallback)

```bash
pnpm --filter @kanera/sdk publish --access public
pnpm --filter @kanera/cli publish --access public
```

`prepublishOnly` runs each package's full test suite, including the packed-tarball install check.
Use `pnpm publish`, not `npm publish`: pnpm rewrites the `workspace:*` ranges in the manifest it
uploads.

## Publishing MCP registry metadata

MCP metadata versions independently (`apps/mcp/server.json`). Tag `mcp-vX.Y.Z` releases, or run
`publish-mcp.yml` manually; it needs the `MCP_PRIVATE_KEY` repository secret. See that workflow for
details.

## Consumer requirements

- `@kanera/cli` requires Node **22+** (`npm install --global @kanera/cli`).
- `@kanera/sdk` requires Node **18+**, or any runtime with global `fetch` (Bun, Deno, Workers,
  browsers).
