# Releasing Kanera

This document covers cutting a workspace release and publishing Kanera's agent-facing surfaces:
the hosted MCP server, `@kanera/cli`, `@kanera/sdk`, MCP Registry metadata, the OpenAI plugin, the
published Claude connector, and the public skill/discovery files on Kanera-site. Deploying the
hosted application itself is documented in [DEPLOY.md](DEPLOY.md).

## What ships where

| Artefact | Registry | Version | Workflow |
| -------- | -------- | ------- | -------- |
| `@kanera/cli` | npm | workspace version (`vX.Y.Z` tags) | `publish-npm.yml` |
| `@kanera/sdk` | npm | workspace version (`vX.Y.Z` tags) | `publish-npm.yml` |
| MCP server metadata | MCP registry | independent (`mcp-vX.Y.Z` tags) | `publish-mcp.yml` |
| OpenAI Kanera plugin | OpenAI universal Plugins Directory | independent plugin version | manual review and publish through the OpenAI plugin portal |
| Kanera Agent Skill | GitHub and `www.kanera.app` | source snapshot | merge this repo, then deploy Kanera-site |
| Published Claude connector | Claude connector directory | live MCP server | deploy MCP; update the directory listing only when its public metadata or connection changes |
| Kanera docs and agent discovery | `www.kanera.app` | site commit | build and deploy the sibling Kanera-site repository |

## Release order

For a change that touches agent routing, the CLI, or public setup guidance, release in this order:

1. Merge the Kanera and Kanera-site changes to each repository's `main` branch.
2. Deploy Kanera so `https://mcp.kanera.app/mcp` serves the new tool catalog and server
   instructions.
3. Deploy Kanera-site so its docs, setup prompt, Agent Skill, and discovery manifests are live.
4. Publish new npm versions when `@kanera/cli` or `@kanera/sdk` changed.
5. Publish a new MCP Registry version only when `apps/mcp/server.json` changed.
6. Scan, submit, and publish the OpenAI plugin when its MCP metadata or bundled skill changed.
7. Verify the published Claude connector against the deployed server. Its listing does not need a
   new submission for an implementation-only MCP deployment.

The GitHub repository secrets currently required by the automated workflows are `NPM_TOKEN`,
`MCP_PRIVATE_KEY`, and `GITLEAKS_LICENSE`.

The workspace release script deliberately leaves `apps/mcp/package.json` and
`apps/mcp/server.json` unchanged. MCP releases use their own version and `mcp-vX.Y.Z` tag; a CLI or
SDK release must not bump them.

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

## Publishing the OpenAI Kanera plugin

`integrations/plugins/kanera` is the source package for the installed Kanera plugin. It references
the registered Kanera app and bundles the canonical Kanera skill, so app tools and routing guidance
arrive together. `pnpm test:integrations` prevents the bundled skill from drifting from
`integrations/skills/kanera`. The plugin and MCP Registry metadata are independently versioned;
bump only the artefact whose reviewed package or metadata changed.

After changing the app metadata, skill, or MCP catalog:

1. Run `pnpm test:integrations` and validate `integrations/plugins/kanera` with the bundled Codex
   `plugin-creator` validator.
2. Deploy the production MCP server and confirm its OAuth flow and tool scan succeed.
3. Open `https://platform.openai.com/plugins` and create or update the **With MCP** submission.
4. Use the universal MCP URL `https://mcp.kanera.app/mcp`, select the verified publisher identity,
   complete domain verification if requested, and select **Scan Tools**.
5. Upload the final `integrations/skills/kanera` directory as the skill bundle.
6. Review the tool annotations, add realistic starter prompts, and supply at least five positive
   and three negative test cases with reviewer-ready credentials when authentication is required.
7. Complete the public listing, privacy, terms, support, availability, and release-note fields,
   then submit it for review.
8. After approval, publish it from the portal. Approval alone does not make the plugin public.
9. Install the published version and test it in a new ChatGPT conversation and a new Codex task.

The portal submission is the public release. The local plugin directory is the validated source
package used for development and review; committing it alone does not replace an installed remote
plugin or its reviewed skill snapshot.

## Verifying the published Claude connector

Kanera is already published as a Claude connector, so no separate Claude Code plugin package is
required. After deploying MCP changes:

1. Find Kanera under **Customize -> Connectors** in Claude and confirm OAuth still reaches the
   Kanera consent screen.
2. Start a fresh conversation with Kanera enabled and make a read-only request using an exact card
   key. Confirm Claude uses Kanera tools rather than opening the Kanera web interface.
3. In Claude Code signed in with the same account, run `claude mcp list` and inspect `/mcp`. Add the
   remote server manually only when the published connector is not delivered to that account.
4. Update the Anthropic directory submission only when the connector's public listing,
   authentication, production URL, or declared capabilities changed.

## Publishing Kanera-site discovery

The sibling `Kanera-site` repository publishes the portable Agent Plugin manifest, MCP manifest,
digest-pinned Agent Skill, setup prompt, and client documentation.

This repository is the source of truth for the Kanera skill. Kanera-site keeps its own committed
copy under `skills/kanera`, and no test spans the two repositories, so after changing
`integrations/skills/kanera` copy it across explicitly:

```bash
cp -r integrations/skills/kanera/. ../Kanera-site/skills/kanera/
```

Then run `npm run test:agent-discovery` in Kanera-site, which regenerates the published copy and
digest under `public/` and verifies they match. Follow its `RELEASING.md`, then verify these
production URLs:

```text
https://www.kanera.app/plugin.json
https://www.kanera.app/mcp.json
https://www.kanera.app/.well-known/agent-skills/index.json
https://www.kanera.app/.well-known/agent-skills/kanera/SKILL.md
https://www.kanera.app/docs/ai-mcp
```

## Consumer requirements

- `@kanera/cli` requires Node **22+** (`npm install --global @kanera/cli`).
- `@kanera/sdk` requires Node **18+**, or any runtime with global `fetch` (Bun, Deno, Workers,
  browsers).
