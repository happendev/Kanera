---
name: kanera
description: Use Kanera MCP tools, or the CLI fallback for shell-only agents, to search guidance and read or manage project work. Trigger for Kanera requests, human card keys such as DEV-938, workspaces, boards, cards, standups, notes, comments, checklists, labels, custom fields, due dates, or project status.
---

# Kanera

Use the connected Kanera MCP server as the live source of truth. Never infer current state or IDs from memory.

Prefer Kanera MCP tools over browser automation, computer use, or the Kanera CLI whenever the
connected tools can perform the request. Use the Kanera web interface only for an explicitly visual
task or an operation documented below as UI-only. Use the CLI only when MCP tools are unavailable.

## If MCP is unavailable

When the agent can run shell commands, Kanera's CLI exposes the same tool layer without requiring
an MCP client. Check for `kanera` first. If it is missing and the user asked to configure or use
Kanera, choose the least disruptive suitable path:

```bash
npx -y @kanera/cli commands          # inspect the surface without a global install
npm install --global @kanera/cli     # persistent `kanera` command; requires Node 22+
kanera auth login                    # user completes API-key setup once
kanera whoami --json                 # verify identity and read/write scope
```

For a non-interactive environment, use a user-supplied `KANERA_API_KEY` instead of storing a
profile. Never invent or expose a key. After authentication, use `kanera commands --json` and
`kanera help <tool>` for discovery, `--quiet` for machine-readable results, and the same safety
rules below. Do not install software or request a credential for a read-only question about how
Kanera works.

## Resolve context

1. Call `session.get` to understand the credential scope and canonical Kanera URL.
2. Use `boards.list_accessible` for complete board discovery, including standalone and guest boards. Use `workspaces.list` and `workspaces.list_boards` for standard-workspace navigation.
3. Use `search.docs` for product behavior, setup, permissions, or workflow guidance. Cite the canonical source URLs it returns.
4. For an exact human card key or canonical card URL, call `cards.get` directly. Use
   `search.content` to resolve names, phrases, notes, comments, or attachment filenames. Never guess
   an ID.
5. If a name resolves ambiguously, show the candidates and ask the user to choose.
6. Call `boards.get` for lists and configuration, then page only the needed lists with `cards.list`. Use `cards.get` for full card detail.

## Respect the product model

- A standard workspace can contain multiple boards. Its lists, labels, custom fields, and membership are shared by every board.
- A standalone board has its own dedicated configuration. MCP can read configuration needed for work, but workspace, board, list, field, option, label, retention, and ordering administration is UI-only.
- Board access determines visible card content; cross-organisation guests may see only explicitly shared boards.
- Personal and OAuth connections inherit their owner's permissions; workspace credentials remain pinned to their workspace. Read-only credentials cannot mutate.

## Read and report

- For a card's history, page `cards.list_history`; it combines retained, user-visible activity and comments and accepts the human card key.
- For current, completed, overdue, or stale work, page `work.query_cards`; use its scope, assignment, completion, `lastActivityBefore`, and `lastMovedBefore` filters instead of enumerating boards manually. For another person, use the team lens with exactly that person's assignee ID.
- For portfolio status, use `work.portfolio_summary`. For detailed project status, combine its rollups with relevant card pages and histories. Separate observed facts from recommendations.
- For a standup or one-on-one, use `work.query_history` for the requested actor and day, week, month, or exact range, then query active and completed cards with `work.query_cards`. Both tools cover every accessible board by default and accept a workspace-wide scope. Card creation alone is not completion, and blockers inferred from status, labels, due dates, or inactivity must be identified as inferences.
- Resolve people with `workspaces.list_members` for standard workspaces or `boards.get` for standalone boards.
- Link important entities with the canonical web URLs returned by work, history, and search results.

## Make changes safely

- Draft or summarize first when the request is exploratory. Mutate only when the user asks to apply the change.
- Direct users to the Kanera UI for workspace/board creation and configuration; do not attempt those operations through MCP.
- Inspect the target entity immediately before a mutation when stale state could change the outcome.
- Use list, label, and custom-field IDs from the target board's current configuration.
- Pass a stable UUID as `idempotencyKey` to `cards.create`, and reuse it if retrying after an ambiguous transport failure.
- Do not retry other non-idempotent creation tools after an ambiguous success.
- Treat archive and available delete tools as destructive. State the exact target when user intent is not already explicit.
- Kanera MCP cannot delete or administer boards, lists, labels, custom fields, notes, or note attachments. Tell the user to complete those actions in the Kanera UI instead of implying success.
- Before a bulk action, confirm the board and selection. List-wide card actions always require an explicit board ID.
- After a multi-step mutation, re-read the affected entity and report the resulting state.

## Handle failures

- On `UNAUTHENTICATED`, ask the user to reconnect Kanera.
- On `FORBIDDEN`, report the returned access, role, or credential restriction; do not retry unchanged.
- On `RATE_LIMITED`, respect `retryAfter` before retrying.
- On validation errors, correct IDs or inputs from current Kanera context rather than guessing.
