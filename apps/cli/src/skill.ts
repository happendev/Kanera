/**
 * The instructions an AI agent gets when `kanera setup` runs. Kept as a template string rather than
 * a file on disk so the installed CLI has no runtime asset paths to resolve, and so the guidance
 * ships and versions with the code that implements it.
 *
 * It deliberately teaches discovery (`kanera commands --json`, `kanera help <tool>`) rather than
 * listing tools: the catalog is generated from the live MCP tool layer and cannot go stale, whereas
 * a hand-written list here would drift the first time a tool is added.
 */
export function skillDocument(): string {
  return `---
name: kanera
description: Read and manage Kanera work from the shell with the kanera CLI. Use when MCP tools are unavailable and the user mentions Kanera, a human card key such as DEV-938, a board, or an "Up next" queue.
---

# Kanera

The \`kanera\` CLI talks to Kanera's public API. Every command accepts \`--json\` for a structured
envelope and \`--quiet\` for the bare result, which is what you should use when parsing output.

Use this shell transport instead of browser automation for supported Kanera work. Open the Kanera
web interface only for an explicitly visual task or an administration operation the CLI does not
expose. When connected Kanera MCP tools are available, prefer those tools over this CLI.

## Before anything else

\`\`\`bash
kanera whoami --json
\`\`\`

If this exits with code 3, ask the user to approve a sign-in, naming yourself so Kanera labels your
work "via <your name> (Kanera CLI on <computer>)" rather than as the user's own:

\`\`\`bash
kanera auth login --agent "Claude Code"
\`\`\`

Use your own product name. Show the user the printed link and code; the command finishes once they
approve. In an unattended environment, use a user-supplied \`KANERA_API_KEY\` instead.

This reports the credential's \`scope\`. **If \`scope\` is \`read\`, the credential cannot change
anything.** Do not attempt writes; say so instead. Write attempts exit with code 4.

## Finding the surface

\`\`\`bash
kanera commands              # grouped, human-readable
kanera commands --json       # every tool with its arguments and whether it mutates
kanera help cards.update
\`\`\`

Prefer this over guessing. Any tool in the catalog is callable as
\`kanera call <tool> --arg value\`, and nested arguments use dots: \`--changes.title "New title"\`.

## Common work

\`\`\`bash
kanera boards --json                       # discover boards
kanera board <boardId> --json              # lists, labels, fields, members
kanera cards <boardId> <listId> --json     # one page of cards from one list
kanera card MKT-42 --json                  # card detail, by key, id, or URL
kanera work --json                         # your assignments across every board
kanera search "landing page" --json
\`\`\`

Card arguments accept a UUID, a human key such as \`MKT-42\`, or a canonical card URL.

## Changing things

\`\`\`bash
kanera card create "Draft the brief" --boardId <id> --listId <id>
kanera card update MKT-42 --changes.title "Revised title"
kanera card done MKT-42
kanera comment MKT-42 "Shipped in 1.4.0."
kanera separator create <boardId> <listId> "This week" --color blue
kanera separator move <separatorId> <listId> --anchor.side before --anchor.item.type card --anchor.item.id <cardId>
\`\`\`

Build a checklist plan in one call, then change several items in one call. List-of-object arguments
take a JSON array; reuse the ids the first call returns:

\`\`\`bash
kanera call checklists.create --cardId MKT-42 --title Launch \\
  --items '[{"text":"Prepare release","subChecklists":[{"title":"Verification","items":[{"text":"Run smoke tests"}]}]},{"text":"Announce launch"}]'
kanera call checklists.update_items --cardId MKT-42 \\
  --updates '[{"itemId":"<itemId>","changes":{"completed":true}},{"itemId":"<itemId>","changes":{"assigneeId":"<userId>"}}]'
\`\`\`

## Show your work

Before multi-step work on a card, start a run so the board shows a live "agent working" chip on it.
Check \`kanera runs\` first so two agents do not work the same card.

\`\`\`bash
kanera runs MKT-42 --quiet                                   # anyone already working it?
kanera run start MKT-42 "Fix the login redirect" --quiet     # keep the returned run id
kanera run update <runId> --summary "Tests passing, opening PR"
kanera run update <runId> --status blocked --summary "Need a decision on the redirect target"
kanera run done <runId> "Merged; redirect fixed"
\`\`\`

Update at least every 10 minutes (a run with no update for 15 minutes is marked stalled). End with
\`kanera run done\`, or \`kanera run update <runId> --status failed\` (or \`cancelled\`) and a summary.
Ended runs cannot be edited. A run is a status signal, not the record: still comment the outcome on
the card.

## Setting up

\`\`\`bash
kanera templates --json                                        # what each template seeds
kanera workspace create "Marketing" --templateId marketing --json
kanera standalone create "Reading list" --templateId simple-todo --json
kanera board create <workspaceId> "Q4 launch" --json
\`\`\`

Workspace and standalone-board creation needs a write-capable personal credential whose user is an
organisation admin; a workspace-scoped key exits 4. Pass \`--templateId blank\` or explicit
\`--lists\` for a minimal setup. Lists, fields, and labels are shared by every board in a workspace.

## Product documentation

\`\`\`bash
kanera docs "how do guest boards work" --quiet    # search the docs; cite the returned URLs
\`\`\`

For a whole page, fetch its Markdown version. The index is https://www.kanera.app/llms.txt. The most
useful pages for shell agents are https://www.kanera.app/docs/cli.md,
https://www.kanera.app/docs/ai-coding-agents.md (the pick-up-to-done loop), and
https://www.kanera.app/docs/ai-agent-runs.md.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | success |
| 1 | the request failed |
| 2 | bad usage — re-read \`kanera help <tool>\` |
| 3 | no valid credential — the user must approve \`kanera auth login --agent "<your name>"\` |
| 4 | forbidden — often a read-only credential, or missing access |
| 5 | not found |
| 6 | rate limited — back off and retry |

## Rules

- Paginate with \`--cursor\`; results are bounded and never return a whole board at once.
- Do not invent ids. Resolve them with \`kanera boards\`, \`kanera board\`, or \`kanera search\`.
- Treat tools marked \`destructive\` as requiring an explicit user request; do not infer deletion,
  archival, replacement, or bulk mutation from a broader read or reporting request.
- Deletion and post-creation administration (renaming lists, fields, labels, members) live in the Kanera UI, not here.
- Personal notes are private to their owner. A \`NOTES_DISABLED\` error means a workspace admin has
  switched notes off for that workspace; say so rather than retrying.
- To link cards or notes, put the target's canonical Kanera URL in a card description or note.
  Kanera turns it into a live link with a backlink. Only items in the same workspace are tracked.
  See https://www.kanera.app/docs/cards.md#link-cards-and-notes.
`;
}

/** Appended to AGENTS.md for agents that read repo conventions instead of skill files. */
export function agentsSection(): string {
  return `## Kanera

Kanera work (workspace setup, boards, cards, comments, notes, priority queues) is reachable from the shell:

\`\`\`bash
kanera whoami --json         # check the credential and its scope first
kanera commands --json       # the full catalog of commands and their arguments
kanera help <tool>           # one tool's arguments
\`\`\`

Use \`--quiet\` when parsing output. A credential whose scope is \`read\` cannot change anything;
write attempts exit with code 4. Card arguments accept a UUID, a key such as \`MKT-42\`, or a card URL.
`;
}
