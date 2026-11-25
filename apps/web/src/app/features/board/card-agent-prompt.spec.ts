import { describe, expect, it } from "vitest";
import type { WireCardChecklist, WireCardChecklistItem } from "@kanera/shared/events";
import { buildCardAgentPrompt } from "./card-agent-prompt";

function item(id: string, text: string, position: string, extra: Partial<WireCardChecklistItem> = {}): WireCardChecklistItem {
  return { id, text, position, description: null, completedAt: null, ...extra } as WireCardChecklistItem;
}

function checklist(id: string, title: string, position: string, items: WireCardChecklistItem[], parentItemId: string | null = null): WireCardChecklist {
  return { id, title, position, parentItemId, items } as WireCardChecklist;
}

const base = { key: "DEV-7", url: "https://kanera.example.com/o/ABC/c/DEV-7", title: "  Fix login  " };

describe("buildCardAgentPrompt", () => {
  it("leads with the card and the MCP tracking instruction, omitting empty sections", () => {
    const prompt = buildCardAgentPrompt({ ...base, description: "   ", checklists: [] });
    expect(prompt.split("\n").slice(0, 3)).toEqual(["Carry out Kanera card DEV-7: Fix login", base.url, ""]);
    expect(prompt).toContain("Kanera MCP");
    expect(prompt).not.toContain("## Description");
    expect(prompt).not.toContain("## Checklist");
  });

  it("orders checklists and items by position and nests sub-checklists under their item", () => {
    const prompt = buildCardAgentPrompt({
      ...base,
      description: "Users bounce back to /login.",
      checklists: [
        checklist("sub", "Steps", "1", [item("s1", "Write test", "1", { completedAt: new Date() })], "i2"),
        checklist("b", "Release", "2", [item("r1", "Deploy", "1")]),
        checklist("a", "Build", "1", [
          item("i2", "Fix redirect", "2", { description: "Keep ?next=\nfor deep links" }),
          item("i1", "Reproduce", "1", { completedAt: new Date() }),
        ]),
      ],
    });
    expect(prompt.slice(prompt.indexOf("## Description"))).toBe([
      "## Description",
      "",
      "Users bounce back to /login.",
      "",
      "## Checklist: Build",
      "",
      "- [x] Reproduce",
      "- [ ] Fix redirect",
      "  Keep ?next=",
      "  for deep links",
      "  - [x] Write test",
      "",
      "## Checklist: Release",
      "",
      "- [ ] Deploy",
    ].join("\n"));
  });
});
