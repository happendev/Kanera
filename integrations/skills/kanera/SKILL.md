---
name: kanera
description: Use Kanera MCP tools to search product guidance and discover, inspect, summarize, triage, create, configure, or update project work. Trigger for requests about Kanera setup, behavior, workspaces, standalone or workspace boards, cards, assigned work, standups, notes, comments, checklists, labels, custom fields, due dates, or project status.
---

# Kanera

Use the connected Kanera MCP server as the live source of truth. Never infer current state or IDs from memory.

## Resolve context

1. Call `kanera_get_session` to understand the credential scope and canonical Kanera URL.
2. Use `kanera_list_accessible_boards` for complete board discovery, including standalone and guest boards. Use `kanera_list_workspaces` and `kanera_list_workspace_boards` for standard-workspace navigation.
3. Use `kanera_search_docs` for product behavior, setup, permissions, or workflow guidance. Cite the canonical source URLs it returns.
4. Use `kanera_search` to resolve live cards, notes, comments, or attachment names. Never guess an ID.
5. If a name resolves ambiguously, show the candidates and ask the user to choose.
6. Call `kanera_get_board` for lists and configuration, then page only the needed lists with `kanera_get_cards_list`. Use `kanera_get_card` for full card detail.

## Respect the product model

- A standard workspace can contain multiple boards. Its lists, labels, custom fields, and membership are shared by every board.
- A standalone board has its own dedicated configuration. For configuration tools, use its public standalone board ID, never its backing workspace ID.
- Board access determines visible card content; cross-organisation guests may see only explicitly shared boards.
- Personal and OAuth connections inherit their owner's permissions; workspace credentials remain pinned to their workspace. Read-only credentials cannot mutate.

## Read and report

- For project status, combine relevant card pages with `kanera_list_activity`. Separate observed facts from recommendations.
- For standups, use `kanera_list_work_done` and `kanera_list_completed_work` for finished work, and `kanera_list_assigned_work` for current work. Card creation alone is not completion.
- Resolve people with `kanera_list_workspace_members` for standard workspaces or `kanera_get_board` for standalone boards.
- Link important entities with the canonical web URLs returned by Kanera when available.

## Make changes safely

- Draft or summarize first when the request is exploratory. Mutate only when the user asks to apply the change.
- If the user asks to create a board without choosing a type, ask whether it should be standalone or belong to an existing standard workspace.
- Inspect the target entity immediately before a mutation when stale state could change the outcome.
- Use list, label, and custom-field IDs from the target board's current configuration.
- Pass a stable UUID as `idempotencyKey` to `kanera_create_card`, and reuse it if retrying after an ambiguous transport failure.
- Do not retry other non-idempotent creation tools after an ambiguous success.
- Treat archive and available delete tools as destructive. State the exact target when user intent is not already explicit.
- Kanera MCP cannot delete boards, lists, labels, or custom fields. Tell the user to delete those in the Kanera UI instead of implying the operation succeeded.
- Before a bulk action, confirm the board and selection. Omitting a board scope from a workspace-level list action can affect cards across multiple boards.
- After a multi-step mutation, re-read the affected entity and report the resulting state.

## Handle failures

- On `UNAUTHENTICATED`, ask the user to reconnect Kanera.
- On `FORBIDDEN`, report the returned access, role, or credential restriction; do not retry unchanged.
- On `RATE_LIMITED`, respect `retryAfter` before retrying.
- On validation errors, correct IDs or inputs from current Kanera context rather than guessing.
