import type { WorkCatalog } from "@kanera/shared/dto";
import { describe, expect, it } from "vitest";
import { boardPickerGroups, scopePickerGroups } from "./work-pickers";

const CATALOG = {
  organisations: [
    { id: "org-1", name: "Acme", external: false },
    { id: "org-2", name: "Globex", external: true },
  ],
  workspaces: [
    { id: "ws-1", organisationId: "org-1", name: "Marketing", icon: "rocket", accentColor: "blue", kind: "standard", viewerCanAccessWorkspace: true },
    { id: "ws-2", organisationId: "org-1", name: "Solo board", icon: null, accentColor: null, kind: "board", viewerCanAccessWorkspace: true },
    { id: "ws-3", organisationId: "org-2", name: "Guest space", icon: null, accentColor: null, kind: "standard", viewerCanAccessWorkspace: false },
  ],
  boards: [
    { id: "b-1", workspaceId: "ws-1", name: "Campaigns", icon: "layout-kanban", iconColor: "blue", viewerRole: "editor", assignedItemsOnly: false },
    { id: "b-2", workspaceId: "ws-2", name: "Solo board", icon: "star", iconColor: null, viewerRole: "editor", assignedItemsOnly: false },
    { id: "b-3", workspaceId: "ws-3", name: "Shared work", icon: null, iconColor: null, viewerRole: "observer", assignedItemsOnly: true },
  ],
  lists: [],
  labels: [],
  customFields: [],
  people: [],
} as unknown as WorkCatalog;

describe("scopePickerGroups", () => {
  it("renders organisation sections with indented boards under their workspace", () => {
    const groups = scopePickerGroups(CATALOG);

    expect(groups[0]!.options[0]).toMatchObject({ id: "", label: "All boards" });
    const acme = groups.find((group) => group.label === "Acme")!;
    expect(acme.options.map((option) => [option.id, option.depth ?? 0])).toEqual([
      ["o:org-1", 0],
      ["w:ws-1", 0],
      // The board sits one level in from its workspace, so the hierarchy reads without extra chrome.
      ["b:b-1", 1],
      // A standalone board has no meaningful workspace row, so it is listed at the top level.
      ["b:b-2", 0],
    ]);
  });

  it("flags guest organisations so cross-organisation access is obvious", () => {
    expect(scopePickerGroups(CATALOG).map((group) => group.label))
      .toEqual([undefined, "Acme", "Globex · Guest"]);
  });

  it("keeps the catalog's sidebar order instead of alphabetising sources", () => {
    const catalog = {
      ...CATALOG,
      organisations: [
        { ...CATALOG.organisations[0]!, name: "Zulu" },
        { ...CATALOG.organisations[1]!, name: "Acme" },
      ],
      boards: [
        { ...CATALOG.boards[0]!, name: "Zulu board" },
        {
          ...CATALOG.boards[0]!,
          id: "b-4",
          name: "Alpha board",
        },
        CATALOG.boards[1]!,
        CATALOG.boards[2]!,
      ],
    } as WorkCatalog;

    const groups = scopePickerGroups(catalog);
    expect(groups.map((group) => group.label)).toEqual([undefined, "Zulu", "Acme · Guest"]);
    expect(groups[1]!.options.map((option) => option.id)).toEqual([
      "o:org-1",
      "w:ws-1",
      "b:b-1",
      "b:b-4",
      "b:b-2",
    ]);
  });
});

describe("boardPickerGroups", () => {
  it("groups selectable boards by workspace and qualifies them when several organisations exist", () => {
    const groups = boardPickerGroups(CATALOG, CATALOG.boards);

    expect(groups.map((group) => [group.label, group.options.map((option) => option.id)])).toEqual([
      ["Acme · Marketing", ["b-1"]],
      // Standalone boards would repeat their own name as a heading, so they file under the org.
      ["Acme", ["b-2"]],
      ["Globex · Guest · Guest space", ["b-3"]],
    ]);
  });

  it("omits workspaces with no selectable board", () => {
    const groups = boardPickerGroups(CATALOG, CATALOG.boards.filter((board) => board.id === "b-1"));
    expect(groups.map((group) => group.label)).toEqual(["Acme · Marketing"]);
  });

  it("keeps boards in their catalog navigation order", () => {
    const boards = [
      { ...CATALOG.boards[0]!, name: "Zulu board" },
      { ...CATALOG.boards[0]!, id: "b-4", name: "Alpha board" },
    ];
    const groups = boardPickerGroups(
      { ...CATALOG, boards } as WorkCatalog,
      boards,
    );

    expect(groups[0]!.options.map((option) => option.id)).toEqual(["b-1", "b-4"]);
  });
});
