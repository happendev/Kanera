import { expandCardSummary, type WireCustomField } from "@kanera/shared/events";
import { describe, expect, it } from "vitest";
import { TILE_HEIGHT } from "./dependency-map.layout";
import { SLIM_TILE_HEIGHT, tileContent, tileFields, tileHeight } from "./dependency-map.tile";

/**
 * Failure modes, each a pure-function edge case the E2E map test cannot enumerate:
 * - a tile shows a field from another workspace, or an unchecked checkbox, or an empty value;
 * - the tile's computed height disagrees with the rows it renders (a "+N more" line not counted,
 *   labels counted when there are none), so connectors miss the tile's middle and tiles overlap;
 * - slim tiles keep the detailed height.
 */

const NOW = new Date("2026-10-19T12:00:00Z");

function field(id: string, type: WireCustomField["type"], extra: Partial<WireCustomField> = {}): WireCustomField {
  return {
    id, workspaceId: "ws", name: id, icon: "forms", type, allowMultiple: false, position: "1", showOnCard: true,
    archivedAt: null, createdAt: NOW, updatedAt: NOW, options: [], ...extra,
  };
}

function card(values: Record<string, Partial<{ valueText: string; valueNumber: string; valueCheckbox: boolean; valueOptionIds: string[] }>>, labelIds: string[] = []) {
  return expandCardSummary({
    id: "c", workspaceId: "ws", organisationKey: "acme", number: 1, key: "K-1", listId: "l", boardId: "b", title: "Card",
    position: "1", createdAt: NOW, updatedAt: NOW, labelIds,
    customFieldValues: Object.entries(values).map(([fieldId, value]) => ({ cardId: "c", fieldId, updatedAt: NOW, ...value })),
  });
}

describe("tileContent", () => {
  const labels = new Map([["red", { id: "red", name: "Urgent", color: "red" }]]);

  it("shows only fields with a value, from the card's own workspace, in field order", () => {
    const fields = new Map([
      ["ws", [field("done", "checkbox"), field("todo", "checkbox"), field("size", "number"), field("note", "text"), field("stage", "select", {
        options: [{ id: "o1", fieldId: "stage", label: "Beta", color: "blue", position: "1", archivedAt: null, createdAt: NOW, updatedAt: NOW }],
      })]],
      ["other", [field("foreign", "text", { workspaceId: "other" })]],
    ]);
    const content = tileContent(card({
      done: { valueCheckbox: true }, todo: { valueCheckbox: false }, size: { valueNumber: "1500" }, note: { valueText: "  " },
      stage: { valueOptionIds: ["o1"] }, foreign: { valueText: "leak" },
    }, ["red", "gone"]), labels, fields);
    expect(content.labels.map((label) => label.name)).toEqual(["Urgent"]);
    expect(content.fields.map((entry) => entry.id)).toEqual(["done", "size", "stage"]);
    expect(content.fields[0]!.text).toBeNull();
    expect(content.fields[2]!.chips).toEqual([{ id: "o1", label: "Beta", color: "blue" }]);
  });

  it("sizes a tile by the rows it renders, including the summary line", () => {
    const many = new Map([["ws", ["a", "b", "c", "d", "e"].map((id) => field(id, "text"))]]);
    const full = tileContent(card(Object.fromEntries(["a", "b", "c", "d", "e"].map((id) => [id, { valueText: id }])), ["red"]), labels, many);
    expect(tileFields(full)).toMatchObject({ more: 3 });
    expect(tileFields(full).fields).toHaveLength(2);
    expect(tileHeight(full, "detailed")).toBe(TILE_HEIGHT + 22 + 2 + 3 * 18);
    expect(tileHeight(tileContent(card({}), labels, many), "detailed")).toBe(TILE_HEIGHT);
    expect(tileHeight(full, "slim")).toBe(SLIM_TILE_HEIGHT);
  });
});
