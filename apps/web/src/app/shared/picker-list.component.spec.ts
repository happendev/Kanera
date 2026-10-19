import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { ComponentFixture } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { PickerListComponent, type PickerGroup } from "./picker-list.component";

const GROUPS: PickerGroup[] = [
  {
    id: "marketing",
    label: "Marketing",
    icon: "rocket",
    options: [
      { id: "m-board", label: "Campaigns", icon: "layout-kanban" },
      { id: "m-doing", label: "Doing", icon: "list", depth: 1 },
    ],
  },
  {
    id: "delivery",
    label: "Delivery",
    icon: "rocket",
    options: [{ id: "d-doing", label: "Doing", icon: "list", depth: 1 }],
  },
];

function nodes(fixture: ComponentFixture<PickerListComponent>, selector: string): HTMLElement[] {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll(selector));
}

function texts(fixture: ComponentFixture<PickerListComponent>, selector: string): (string | undefined)[] {
  return nodes(fixture, selector).map((node) => node.textContent?.trim());
}

describe("PickerListComponent", () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  function render(groups: PickerGroup[], selectedIds: string[] = []) {
    const fixture = TestBed.createComponent(PickerListComponent);
    fixture.componentRef.setInput("groups", groups);
    fixture.componentRef.setInput("selectedIds", selectedIds);
    fixture.detectChanges();
    return fixture;
  }

  it("renders a heading per group so identically named options stay distinguishable", () => {
    const fixture = render(GROUPS);

    expect(texts(fixture, ".pl-group")).toEqual(["Marketing", "Delivery"]);
    expect(texts(fixture, ".pl-row")).toEqual(["Campaigns", "Doing", "Doing"]);
    fixture.destroy();
  });

  it("indents grouped and nested options so hierarchy reads without extra chrome", () => {
    const fixture = render(GROUPS);
    const [board, list] = nodes(fixture, ".pl-row");

    // Under a heading every row steps in once, then once more per nesting level, so the heading
    // visibly owns its rows instead of sharing their left edge.
    expect(board!.style.paddingLeft).toBe("20px");
    expect(list!.style.paddingLeft).toBe("34px");
    expect(board!.classList.contains("is-grouped")).toBe(true);
    fixture.destroy();
  });

  it("does not indent options in an unlabelled group", () => {
    const fixture = render([{ id: "flat", options: [{ id: "a", label: "Alpha" }] }]);
    const [row] = nodes(fixture, ".pl-row");

    expect(row!.style.paddingLeft).toBe("8px");
    expect(row!.classList.contains("is-grouped")).toBe(false);
    fixture.destroy();
  });

  it("keeps group headings while searching, and matches on the group name too", () => {
    const fixture = render(GROUPS);
    fixture.componentInstance.query.set("delivery");
    fixture.detectChanges();

    const rows = nodes(fixture, ".pl-row");
    expect(texts(fixture, ".pl-group")).toEqual(["Delivery"]);
    expect(rows.length).toBe(1);
    // Matches are flattened: a hit keeps its group's single step of indentation, but not the depth
    // of a parent row that may have been filtered out.
    expect(rows[0]!.style.paddingLeft).toBe("20px");
    fixture.destroy();
  });

  it("marks the selected option and emits the picked id", () => {
    const fixture = render(GROUPS, ["d-doing"]);
    const picked: string[] = [];
    fixture.componentInstance.pick.subscribe((id: string) => picked.push(id));

    const rows = nodes(fixture, ".pl-row");
    expect(rows.filter((row) => row.classList.contains("is-selected")).length).toBe(1);

    rows[0]!.click();
    expect(picked).toEqual(["m-board"]);
    fixture.destroy();
  });

  function key(target: HTMLElement, key: string) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  const MANY: PickerGroup[] = [
    {
      id: "flat",
      options: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta", disabled: true },
        { id: "c", label: "Gamma" },
        { id: "d", label: "Delta" },
      ],
    },
  ];

  function renderSearchable(groups: PickerGroup[] = MANY) {
    const fixture = TestBed.createComponent(PickerListComponent);
    fixture.componentRef.setInput("groups", groups);
    fixture.componentRef.setInput("searchThreshold", 1);
    fixture.detectChanges();
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(".pl-search")!;
    return { fixture, input };
  }

  function activeText(fixture: ComponentFixture<PickerListComponent>) {
    return nodes(fixture, ".pl-row.is-active").map((node) => node.textContent?.trim());
  }

  it("wires the search as a combobox that points at the active option", () => {
    const { fixture, input } = renderSearchable();
    const list = (fixture.nativeElement as HTMLElement).querySelector(".pl-list")!;

    expect(input.getAttribute("role")).toBe("combobox");
    expect(list.getAttribute("role")).toBe("listbox");
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);

    key(input, "ArrowDown");
    fixture.detectChanges();
    const [active] = nodes(fixture, ".pl-row.is-active");
    expect(active!.getAttribute("role")).toBe("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(active!.id);
    fixture.destroy();
  });

  it("moves the active row with the arrows, wrapping and skipping disabled rows", () => {
    const { fixture, input } = renderSearchable();

    key(input, "ArrowDown");
    fixture.detectChanges();
    expect(activeText(fixture)).toEqual(["Alpha"]);

    key(input, "ArrowDown");
    fixture.detectChanges();
    expect(activeText(fixture)).toEqual(["Gamma"]);

    key(input, "ArrowDown");
    key(input, "ArrowDown");
    fixture.detectChanges();
    expect(activeText(fixture)).toEqual(["Alpha"]);

    key(input, "ArrowUp");
    fixture.detectChanges();
    expect(activeText(fixture)).toEqual(["Delta"]);
    fixture.destroy();
  });

  it("jumps with Home and End and picks the active row on Enter", () => {
    const { fixture, input } = renderSearchable();
    const picked: string[] = [];
    fixture.componentInstance.pick.subscribe((id: string) => picked.push(id));

    key(input, "End");
    fixture.detectChanges();
    expect(activeText(fixture)).toEqual(["Delta"]);

    key(input, "Home");
    fixture.detectChanges();
    expect(activeText(fixture)).toEqual(["Alpha"]);

    const enter = key(input, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(picked).toEqual(["a"]);
    fixture.destroy();
  });

  it("ignores Enter while nothing is active, so an unfiltered list never picks by accident", () => {
    const { fixture, input } = renderSearchable();
    const picked: string[] = [];
    fixture.componentInstance.pick.subscribe((id: string) => picked.push(id));

    key(input, "Enter");
    expect(picked).toEqual([]);
    fixture.destroy();
  });

  it("makes the top hit active when the query changes and clears it when the query is emptied", () => {
    const { fixture, input } = renderSearchable();

    key(input, "End");
    input.value = "ta";
    input.dispatchEvent(new Event("input"));
    fixture.detectChanges();
    // "Beta" matches but is disabled, so the first pickable hit is "Delta".
    expect(activeText(fixture)).toEqual(["Delta"]);

    input.value = "";
    input.dispatchEvent(new Event("input"));
    fixture.detectChanges();
    expect(activeText(fixture)).toEqual([]);
    fixture.destroy();
  });

  it("lets a mouse hover set the active row but not a touch", () => {
    const { fixture } = renderSearchable();
    const [, , gamma, delta] = nodes(fixture, ".pl-row");

    gamma!.dispatchEvent(Object.assign(new MouseEvent("pointermove", { bubbles: true, movementX: 2 }), { pointerType: "mouse" }));
    fixture.detectChanges();
    expect(activeText(fixture)).toEqual(["Gamma"]);

    delta!.dispatchEvent(Object.assign(new MouseEvent("pointermove", { bubbles: true, movementX: 2 }), { pointerType: "touch" }));
    fixture.detectChanges();
    expect(activeText(fixture)).toEqual(["Gamma"]);
    fixture.destroy();
  });

  it("marks selection with aria-selected and keeps rows out of the tab order behind a search", () => {
    const fixture = TestBed.createComponent(PickerListComponent);
    fixture.componentRef.setInput("groups", MANY);
    fixture.componentRef.setInput("selectedIds", ["c"]);
    fixture.componentRef.setInput("searchThreshold", 1);
    fixture.detectChanges();

    const rows = nodes(fixture, ".pl-row");
    expect(rows.map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "false", "true", "false"]);
    expect(rows.every((row) => row.getAttribute("tabindex") === "-1")).toBe(true);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    fixture.destroy();
  });

  it("moves focus between rows with the arrows when the list has no search box", () => {
    const fixture = render([{ id: "flat", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] }]);
    // Focus only lands on attached elements.
    document.body.appendChild(fixture.nativeElement as HTMLElement);
    const [alpha, beta] = nodes(fixture, ".pl-row");
    expect(alpha!.hasAttribute("tabindex")).toBe(false);

    alpha!.focus();
    key(alpha!, "ArrowDown");
    fixture.detectChanges();
    expect(document.activeElement).toBe(beta);
    fixture.destroy();
  });

  it("highlights the matched part of each label without touching the rest", () => {
    const { fixture, input } = renderSearchable();
    input.value = "EL";
    input.dispatchEvent(new Event("input"));
    fixture.detectChanges();

    expect(texts(fixture, ".pl-row")).toEqual(["Delta"]);
    expect(texts(fixture, ".pl-row mark")).toEqual(["el"]);
    fixture.destroy();
  });
});
