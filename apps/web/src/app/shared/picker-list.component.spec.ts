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
});
