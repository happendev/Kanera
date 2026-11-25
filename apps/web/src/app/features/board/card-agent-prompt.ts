import type { WireCardChecklist } from "@kanera/shared/events";

export interface CardAgentPromptInput {
  key: string;
  url: string;
  title: string;
  description: string | null;
  checklists: readonly WireCardChecklist[];
}

/**
 * A ready-to-paste prompt that hands a card to a coding agent. Like the agent setup prompt it stays
 * in English whatever the viewer's locale: it is instructions for a model, and the phrasing
 * ("carry out a Kanera card") matches the Kanera MCP server's own tracking instructions, so a
 * connected agent starts a run and keeps the card updated. The card content is a snapshot, which is
 * why the agent is told to re-read the card before starting.
 */
export function buildCardAgentPrompt(input: CardAgentPromptInput): string {
  const lines = [
    `Carry out Kanera card ${input.key}: ${input.title.trim()}`,
    input.url,
    "",
    "Track the work on the card through the Kanera MCP: read the card and its comments first (the copy below may be out of date), start an agent run, move the card to the board's active list, keep the run updated, and finish with an outcome comment.",
  ];

  const description = input.description?.trim();
  if (description) lines.push("", "## Description", "", description);

  // Sub-checklists hang off a top-level item (parentItemId), so they render nested under it.
  const subChecklists = new Map<string, WireCardChecklist[]>();
  for (const checklist of input.checklists) {
    if (!checklist.parentItemId) continue;
    subChecklists.set(checklist.parentItemId, [...(subChecklists.get(checklist.parentItemId) ?? []), checklist]);
  }
  const itemLines = (checklist: WireCardChecklist, depth: number): string[] =>
    [...checklist.items].sort(byPosition).flatMap((item) => {
      const indent = "  ".repeat(depth);
      const out = [`${indent}- [${item.completedAt ? "x" : " "}] ${item.text.trim()}`];
      const detail = item.description?.trim();
      if (detail) out.push(...detail.split("\n").map((line) => `${indent}  ${line}`.trimEnd()));
      for (const sub of (subChecklists.get(item.id) ?? []).sort(byPosition)) out.push(...itemLines(sub, depth + 1));
      return out;
    });

  for (const checklist of input.checklists.filter((c) => !c.parentItemId).sort(byPosition)) {
    lines.push("", `## Checklist: ${checklist.title.trim()}`, "", ...itemLines(checklist, 0));
  }

  return lines.join("\n");
}

function byPosition(a: { position: string }, b: { position: string }): number {
  return Number(a.position) - Number(b.position);
}
