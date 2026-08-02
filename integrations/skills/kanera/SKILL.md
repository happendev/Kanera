---
name: kanera
description: Use Kanera MCP tools to search product guidance and discover, inspect, summarize, triage, create, or update project work. Trigger for requests about Kanera behavior, workspaces, boards, cards, standups, notes, comments, checklists, labels, custom fields, due dates, or project status.
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
- A standalone board has its own dedicated configuration. MCP can read configuration needed for work, but workspace, board, list, field, option, label, retention, and ordering administration is UI-only.
- Board access determines visible card content; cross-organisation guests may see only explicitly shared boards.
- Personal and OAuth connections inherit their owner's permissions; workspace credentials remain pinned to their workspace. Read-only credentials cannot mutate.

## Read and report

- For a card's history, page `kanera_list_card_history`; it combines retained, user-visible activity and comments and accepts the human card key.
- For team workload and stale-work triage, page `kanera_query_work_cards`; use its scope, assignment, overdue, unassigned, `lastActivityBefore`, and `lastMovedBefore` filters instead of enumerating boards manually.
- For portfolio status, use `kanera_get_portfolio_summary`. For detailed project status, combine its rollups with relevant card pages and histories. Separate observed facts from recommendations.
- For personal standups, use `kanera_list_my_work_history` for the requested day, week, month, or exact range, then page `kanera_list_my_current_work` for work in flight. These tools cover every accessible board by default; narrow their scope only when the user asks. Card creation alone is not completion, and blockers inferred from status, labels, or due dates must be identified as inferences.
- Resolve people with `kanera_list_workspace_members` for standard workspaces or `kanera_get_board` for standalone boards.
- Link important entities with the canonical web URLs returned by Kanera when available.

## Make changes safely

- Draft or summarize first when the request is exploratory. Mutate only when the user asks to apply the change.
- Direct users to the Kanera UI for workspace/board creation and configuration; do not attempt those operations through MCP.
- Inspect the target entity immediately before a mutation when stale state could change the outcome.
- Use list, label, and custom-field IDs from the target board's current configuration.
- Pass a stable UUID as `idempotencyKey` to `kanera_create_card`, and reuse it if retrying after an ambiguous transport failure.
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
