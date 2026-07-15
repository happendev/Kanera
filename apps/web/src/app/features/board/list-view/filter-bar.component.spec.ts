import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { ComponentFixture } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilterBarComponent } from "./filter-bar.component";
import type { FilterValue } from "./filter.types";
import type { AnyCustomField } from "./list-view.types";

const EMPTY: FilterValue = {
  labelIds: [],
  memberIds: [],
  listIds: [],
  boardIds: [],
  cfConditions: [],
  showUnreadOnly: false,
  showOverdueOnly: false,
};

const LABELS = [
  { id: "l1", name: "Bug", color: "red" },
  { id: "l2", name: "Urgent", color: "orange" },
];

const LISTS = [
  { id: "li1", name: "Todo", icon: "list" },
  { id: "li2", name: "Doing", icon: "list" },
];

function selectField(): AnyCustomField {
  return {
    id: "f1",
    workspaceId: "w1",
    name: "Priority",
    icon: "flag",
    type: "select",
    position: "1000.0000000000",
    showOnCard: true,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    options: [
      { id: "o1", label: "High", color: "red", position: "1000.0000000000" },
      { id: "o2", label: "Low", color: "gray", position: "2000.0000000000" },
    ],
  } as unknown as AnyCustomField;
}

function textField(): AnyCustomField {
  return {
    id: "text-1",
    workspaceId: "w1",
    name: "Client",
    icon: "forms",
    type: "text",
    position: "1000.0000000000",
    showOnCard: true,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as AnyCustomField;
}

function makeFixture(value: FilterValue, inputs: Record<string, unknown> = {}): ComponentFixture<FilterBarComponent> {
  TestBed.configureTestingModule({
    imports: [FilterBarComponent],
    providers: [provideZonelessChangeDetection()],
  });
  const fixture = TestBed.createComponent(FilterBarComponent);
  fixture.componentRef.setInput("value", value);
  fixture.componentRef.setInput("labels", LABELS);
  fixture.componentRef.setInput("lists", LISTS);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  fixture.detectChanges();
  return fixture;
}

/** Click the first button whose text contains `text`. */
function clickButton(fixture: ComponentFixture<FilterBarComponent>, text: string) {
  const buttons = Array.from(fixture.nativeElement.querySelectorAll("button")) as HTMLButtonElement[];
  const btn = buttons.find((b) => (b.textContent ?? "").includes(text));
  if (!btn) throw new Error(`No button containing "${text}". Buttons: ${buttons.map((b) => b.textContent?.trim()).join(" | ")}`);
  btn.click();
  fixture.detectChanges();
}

describe("FilterBarComponent", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps active filters inside the panel: a count badge on the button and a per-row summary", () => {
    const fixture = makeFixture({ ...EMPTY, labelIds: ["l1", "l2"], showUnreadOnly: true });

    // The toolbar button carries only a count badge — no chips clutter the nav bar.
    const btnText = (fixture.nativeElement.querySelector(".fb-btn") as HTMLElement).textContent!.replace(/\s+/g, " ");
    expect(btnText).toContain("3"); // 2 labels + unread
    expect(fixture.nativeElement.querySelector(".fb-chip")).toBeNull();

    // Opening the panel shows the active selection summary on the Labels row.
    clickButton(fixture, "Filter");
    const labelsRow = Array.from(fixture.nativeElement.querySelectorAll(".fb-row")).find((r) =>
      ((r as HTMLElement).textContent ?? "").includes("Labels"),
    ) as HTMLElement;
    expect(labelsRow.textContent!.replace(/\s+/g, " ")).toContain("Bug +1");
  });

  it("drills into a dimension and toggling an option emits the updated ids", () => {
    const fixture = makeFixture(EMPTY);
    let emitted: FilterValue | undefined;
    fixture.componentInstance.valueChange.subscribe((v) => (emitted = v));

    clickButton(fixture, "Filter"); // open the menu
    clickButton(fixture, "Labels"); // drill into labels
    clickButton(fixture, "Urgent"); // toggle a label on
    expect(emitted?.labelIds).toEqual(["l2"]);
  });

  it("allows multiple boards to be selected", () => {
    const fixture = makeFixture(EMPTY, {
      showBoards: true,
      boards: [
        { id: "b1", name: "Product" },
        { id: "b2", name: "Marketing" },
      ],
    });
    const emissions: FilterValue[] = [];
    fixture.componentInstance.valueChange.subscribe((value) => {
      emissions.push(value);
      // The filter bar is controlled, so mirror how the parent accepts each selection.
      fixture.componentRef.setInput("value", value);
      fixture.detectChanges();
    });

    clickButton(fixture, "Filter");
    clickButton(fixture, "Boards");
    clickButton(fixture, "Product");
    clickButton(fixture, "Marketing");

    expect(emissions.at(-1)?.boardIds).toEqual(["b1", "b2"]);
  });

  it("closes when the parent bumps the close token", () => {
    const fixture = makeFixture(EMPTY);

    clickButton(fixture, "Filter");
    expect(fixture.nativeElement.querySelector(".fb-panel")).not.toBeNull();

    fixture.componentRef.setInput("closeToken", 1);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(".fb-panel")).toBeNull();
  });

  it("emits opened when the drawer opens so parents can preload filter data", () => {
    const fixture = makeFixture(EMPTY);
    let opened = 0;
    fixture.componentInstance.opened.subscribe(() => opened++);

    clickButton(fixture, "Filter");

    expect(opened).toBe(1);
  });

  it("routes the Unread toggle through valueChange and Archived through archivedChange", () => {
    const fixture = makeFixture(EMPTY, { showArchived: true });
    let value: FilterValue | undefined;
    let archived: boolean | undefined;
    fixture.componentInstance.valueChange.subscribe((v) => (value = v));
    fixture.componentInstance.archivedChange.subscribe((v) => (archived = v));

    clickButton(fixture, "Filter");
    clickButton(fixture, "Unread");
    expect(value?.showUnreadOnly).toBe(true);

    clickButton(fixture, "Archived");
    expect(archived).toBe(true); // server-reload dimension uses its own output
  });

  it("adds a custom-field condition and picking an option emits it", () => {
    const fixture = makeFixture(EMPTY, { customFields: [selectField()] });
    const emissions: FilterValue[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => {
      emissions.push(v);
      // Simulate the controlled parent feeding the new value back in.
      fixture.componentRef.setInput("value", v);
      fixture.detectChanges();
    });

    clickButton(fixture, "Filter");
    clickButton(fixture, "Custom fields");
    clickButton(fixture, "Priority"); // seeds a condition on the field and opens its editor
    expect(emissions.at(-1)?.cfConditions).toEqual([{ fieldId: "f1", op: "isAnyOf" }]);

    clickButton(fixture, "High"); // pick an option id
    expect(emissions.at(-1)?.cfConditions).toEqual([{ fieldId: "f1", op: "isAnyOf", ids: ["o1"] }]);
  });

  it("debounces typed custom-field operands before emitting", async () => {
    const fixture = makeFixture({
      ...EMPTY,
      cfConditions: [{ fieldId: "text-1", op: "contains" }],
    }, { customFields: [textField()] });
    const emissions: FilterValue[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => emissions.push(v));

    fixture.componentInstance.editCondition(0);
    fixture.componentInstance.patchCfDebounced({ value: "a" });
    fixture.componentInstance.patchCfDebounced({ value: "ac" });
    expect(emissions).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 275));
    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.cfConditions).toEqual([{ fieldId: "text-1", op: "contains", value: "ac" }]);
  });

  it("flushes a pending typed operand before pruning on close", () => {
    const fixture = makeFixture({
      ...EMPTY,
      cfConditions: [{ fieldId: "text-1", op: "contains" }],
    }, { customFields: [textField()] });
    const emissions: FilterValue[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => {
      emissions.push(v);
      fixture.componentRef.setInput("value", v);
      fixture.detectChanges();
    });

    fixture.componentInstance.editCondition(0);
    fixture.componentInstance.patchCfDebounced({ value: "Acme" });
    clickButton(fixture, "Filter");
    (fixture.nativeElement.querySelector(".fb-btn") as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(emissions.at(-1)?.cfConditions).toEqual([{ fieldId: "text-1", op: "contains", value: "Acme" }]);
  });


  it("drops a half-built custom-field condition when you leave the editor without a value", () => {
    const fixture = makeFixture(EMPTY, { customFields: [selectField()] });
    const emissions: FilterValue[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => {
      emissions.push(v);
      fixture.componentRef.setInput("value", v);
      fixture.detectChanges();
    });

    clickButton(fixture, "Filter");
    clickButton(fixture, "Custom fields");
    clickButton(fixture, "Priority"); // seeds a condition, opens the editor (no ids picked yet)
    expect(emissions.at(-1)?.cfConditions).toHaveLength(1);

    // Going back without picking any option must discard the empty condition.
    (fixture.nativeElement.querySelector(".fb-back") as HTMLElement).click();
    fixture.detectChanges();
    expect(emissions.at(-1)?.cfConditions).toEqual([]);
  });

  it("Clear all fires the dedicated output so the page runs one comprehensive reset", () => {
    const fixture = makeFixture({ ...EMPTY, labelIds: ["l1"], listIds: ["li1"], showOverdueOnly: true });
    let cleared = false;
    fixture.componentInstance.clearAll.subscribe(() => (cleared = true));

    clickButton(fixture, "Filter"); // Clear all lives inside the panel menu
    clickButton(fixture, "Clear all");
    expect(cleared).toBe(true);
  });
});
