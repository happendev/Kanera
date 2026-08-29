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
description: Read and manage Kanera work — boards, cards, comments, notes, and priority queues — from the shell with the kanera CLI. Use when the user mentions Kanera, a card key like MKT-42, a board, or their "Up next" queue.
---

# Kanera

The \`kanera\` CLI talks to Kanera's public API. Every command accepts \`--json\` for a structured
envelope and \`--quiet\` for the bare result, which is what you should use when parsing output.

## Before anything else

\`\`\`bash
kanera whoami --json
\`\`\`

This reports the credential's \`scope\`. **If \`scope\` is \`read\`, the credential cannot change
anything.** Do not attempt writes; say so instead. Write attempts exit with code 4.

## Finding the surface

\`\`\`bash
kanera commands              # grouped, human-readable
kanera commands --json       # every tool with its arguments and whether it mutates
kanera help kanera_update_card
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
\`\`\`

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | success |
| 1 | the request failed |
| 2 | bad usage — re-read \`kanera help <tool>\` |
| 3 | no valid credential — the user must run \`kanera auth login\` |
| 4 | forbidden — often a read-only credential, or missing access |
| 5 | not found |
| 6 | rate limited — back off and retry |

## Rules

- Paginate with \`--cursor\`; results are bounded and never return a whole board at once.
- Do not invent ids. Resolve them with \`kanera boards\`, \`kanera board\`, or \`kanera search\`.
- Treat tools marked \`destructive\` as requiring an explicit user request; do not infer deletion,
  archival, replacement, or bulk mutation from a broader read or reporting request.
- Deletion and workspace administration mostly live in the Kanera UI, not here.
- Personal notes are private to their owner.
`;
}

/** Appended to AGENTS.md for agents that read repo conventions instead of skill files. */
export function agentsSection(): string {
  return `## Kanera

Kanera work (boards, cards, comments, notes, priority queues) is reachable from the shell:

\`\`\`bash
kanera whoami --json         # check the credential and its scope first
kanera commands --json       # the full catalog of commands and their arguments
kanera help <tool>           # one tool's arguments
\`\`\`

Use \`--quiet\` when parsing output. A credential whose scope is \`read\` cannot change anything;
write attempts exit with code 4. Card arguments accept a UUID, a key such as \`MKT-42\`, or a card URL.
`;
}
