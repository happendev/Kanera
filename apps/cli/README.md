# `kanera` CLI

Manage Kanera work from a terminal, or from any AI agent that can run shell commands.

## Install

Requires Node 22 or newer. The package has no dependencies.

```bash
npm install --global @kanera/cli
```

An agent can inspect the complete command surface without installing anything globally:

```bash
npx -y @kanera/cli commands
```

## Authenticate

```bash
kanera auth login        # sign in through your browser
kanera whoami            # who am I, and what may this credential do?
```

`auth login` uses the OAuth device flow, the same way Claude or Codex connects. It prints a link
and a short code, opens the link in your browser, and finishes when you approve the code there.
It works over SSH too: open the link on any device. Pass `--no-browser` to only print the link.
The CLI stores a short-lived access token and a refresh token, refreshes them automatically, and
appears under **Settings → AI agents** as "Kanera CLI (your machine)", where you can revoke it.
`kanera auth logout` revokes it for you.

Use an API key for CI, cron, or an unattended agent, where nobody can approve a browser sign-in,
or when you want a server-enforced **read-only** credential:

```bash
kanera auth login --with-api-key        # opens the API-keys page, then prompts for the key
kanera auth login --api-key kanera_u_…  # store a key non-interactively
```

Create keys in the web app under **Settings → API keys**, or in **workspace settings** for a key
tied to a workspace rather than a person. In CI or an agent sandbox, skip the stored profile and
set `KANERA_API_KEY` instead.

Self-hosting? A browser sign-in needs your deployment's MCP address, because the sign-in is bound
to it: `kanera auth login --mcp-url https://your-kanera.example/mcp` (or `KANERA_MCP_URL`). For an
API key, point at your public API with `--url https://api.your-kanera.example` during login (it is
saved with the profile) or via `KANERA_PUBLIC_API_URL`.

## Use

```bash
kanera commands          # everything this CLI can do (works before login)
kanera work              # your assignments across every accessible board
kanera card MKT-42       # a card, by key, id, or URL
kanera card done MKT-42  # mark it complete
kanera comment MKT-42 "Shipped."
kanera separator create <boardId> <listId> "This week" --color blue
kanera separator move <separatorId> <listId> --anchor.side before --anchor.item.type card --anchor.item.id <cardId>
kanera workspace create "Marketing" --templateId marketing   # bootstrap a workspace (org admin)
kanera standalone create "Reading list" --templateId simple-todo
kanera doctor            # diagnose credentials and connectivity
```

## How it is built

The CLI does not re-implement the public API. It opens an MCP session against the same tool layer
`@kanera/mcp` serves over HTTP and stdio, then exposes those tools as commands. With an API key the
session is **in-process**: nothing crosses a socket, `InMemoryTransport` links the two ends
directly. With an OAuth sign-in it connects to the **remote MCP endpoint**, because OAuth tokens
are issued for that endpoint and are never accepted by `/api/v1`.

That choice is the point: card-reference resolution (`MKT-42`), cursor encoding, response size
caps, and every tool description already live in that layer, so the CLI's command surface cannot
drift from what agents see over MCP, and a newly added tool is callable from the shell the day it
ships.

- `src/aliases.ts` gives the high-traffic tools ergonomic names (`kanera card done MKT-42`). It is
  a convenience layer, not the surface; a test asserts every alias targets a real tool and only
  maps arguments that tool accepts.
- `kanera call <tool>` reaches anything the alias table does not cover.
- `kanera commands --json` is the machine-readable catalog agents use to discover the rest.

## Credentials

Resolution order: `--api-key`, then `KANERA_API_KEY`, then a stored profile (OAuth sign-in or API
key). An explicit key always wins, so CI never runs through a developer's personal sign-in.

Profiles live in `~/.config/kanera/config.json` (mode `600`). Concurrent `kanera` processes take a
lock before refreshing an OAuth sign-in: Kanera rotates refresh tokens and revokes a sign-in whose
spent refresh token is presented twice, so parallel agent commands must not race. Named profiles let one machine hold
several identities:

```bash
kanera auth login --profile agent --api-key kanera_u_…
kanera --profile agent work --json
```

The non-secret, committable per-repo profile selection goes in `.kanera/config.json`:

```json
{ "profile": "agent" }
```

API origins are security-sensitive because they receive the bearer credential, so repository
configuration cannot set one. Use `--url`, `KANERA_PUBLIC_API_URL`, or the origin saved with a
profile during `auth login`. Non-loopback origins must use HTTPS.

## Output

| Flag | Output |
| ---- | ------ |
| *(none)* | Human-readable tables and summaries |
| `--json` | `{ ok, tool, data }` envelope |
| `--quiet` | The bare result, for `jq` |

Failures always go to **stderr**, so redirecting stdout to a file never mixes an error envelope
into what the caller believes is result data.

Rate-limit and transient API failures include `retryable` and, when supplied by the server,
`retryAfter` fields in structured output.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | success |
| 1 | the request failed |
| 2 | bad usage |
| 3 | no valid credential |
| 4 | forbidden — often a read-only credential |
| 5 | not found |
| 6 | rate limited |

`4` is deliberately distinct from `1`: an agent holding a read-scoped key needs to tell "I may not
do this" apart from "this did not work", and stop rather than retry.

## Arguments

Flags map onto tool arguments and are coerced using the tool's own JSON Schema, never by how the
value looks — a card key can look numeric and an id can look boolean.

Unknown flags, missing required arguments, malformed `--json-args`, and surplus positionals are
usage errors. The CLI never silently discards an operand.

```bash
kanera card update MKT-42 --changes.title "Revised"     # dots nest
kanera work --scope.boardIds[] abc --scope.boardIds[] def   # repeat or [] for arrays
kanera call cards.update --json-args '{"cardId":"MKT-42","changes":{"title":"Revised"}}'
```

## Agent setup

```bash
kanera setup claude     # writes .claude/skills/kanera/SKILL.md
kanera setup codex      # appends Kanera instructions to AGENTS.md
kanera skill            # print the portable Agent Skill document for another harness
kanera mcp              # serve the same tools over stdio MCP, using the stored credential
```

`kanera mcp` means a user who has already run `kanera auth login` does not configure a second
credential in a second place to use Kanera from an MCP client.

When connected Kanera MCP tools are already available, prefer them over the CLI. The CLI is the
fallback for shell-only agents; both transports should be used instead of browser automation for
supported card and project operations.
