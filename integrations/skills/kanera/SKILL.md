---
name: kanera
description: Use Kanera through its MCP tools to inspect, summarize, triage, create, or update project work. Trigger for requests involving Kanera workspaces, boards, cards, assigned work, standups, notes, comments, checklists, labels, custom fields, due dates, or project-status reporting.
---

# Kanera

Use the connected Kanera MCP server as the live source of truth. Never infer current work from memory.

## Establish context

1. Call `kanera_get_session` to understand the credential scope and canonical Kanera URL.
2. Use `kanera_list_workspaces`, `kanera_list_boards`, or `kanera_resolve` to turn human names into stable IDs.
3. Read the relevant board, card, note, or assigned-work collection before proposing changes.
4. If a name resolves ambiguously, show the candidates and ask the user to choose.

Remember these product invariants:

- Lists, labels, and custom fields belong to a workspace and are shared by its boards.
- Board access determines visible card content; cross-organisation guests may see only explicitly shared boards.
- Personal connections act as their owner for board content but cannot administer workspaces.
- Tool results contain full current entities, not diffs.

## Read and report

- For project status, open the board and combine card state with recent activity. Separate observed facts from recommendations.
- For standups, use work-done/completed-work for finished work and assigned-work for current work. Do not describe creation alone as completion.
- For workload reviews, resolve the person through workspace members before using assignee tools.
- Link important entities with the canonical web URLs returned by Kanera when available.

## Make changes safely

- Draft or summarize first when the request is exploratory. Mutate only when the user asks to apply the change.
- Inspect the target entity immediately before a mutation when stale state could change the outcome.
- Use the exact workspace-scoped list, label, or custom-field ID from the target board/workspace context.
- Pass a stable UUID as `idempotencyKey` to `kanera_create_card`, and reuse it if retrying after an ambiguous transport failure.
- Treat archive and delete tools as destructive. State the exact target when user intent is not already explicit.
- After a multi-step mutation, re-read the affected entity and report the resulting state.

## Handle failures

- On `UNAUTHENTICATED`, ask the user to reconnect Kanera.
- On `FORBIDDEN`, explain whether the connection lacks write scope or the user lacks access; do not keep retrying.
- On `RATE_LIMITED`, respect `retryAfter` before retrying.
- On validation errors, correct IDs or inputs from current Kanera context rather than guessing.
