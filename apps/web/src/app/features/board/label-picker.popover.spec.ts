import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { ComponentFixture } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { LabelPickerPopover, type LabelPickerLabel } from "./label-picker.popover";

const LABELS: LabelPickerLabel[] = [
  { id: "l-bug", name: "Bug", color: "red", position: "1" },
  { id: "l-design", name: "Design", color: "blue", position: "2" },
  { id: "l-debt", name: "Tech debt", color: null, position: "3" },
];

describe("LabelPickerPopover", () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  function render(canCreate = false, selectedIds: string[] = []) {
    const fixture = TestBed.createComponent(LabelPickerPopover);
    fixture.componentRef.setInput("labels", LABELS);
    fixture.componentRef.setInput("selectedIds", selectedIds);
    fixture.componentRef.setInput("canCreate", canCreate);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector<HTMLInputElement>(".lp-search")!;
    const toggled: string[] = [];
    const created: string[] = [];
    fixture.componentInstance.toggle.subscribe((id: string) => toggled.push(id));
    fixture.componentInstance.create.subscribe((name: string) => created.push(name));
    return { fixture, root, input, toggled, created };
  }

  function type(fixture: ComponentFixture<LabelPickerPopover>, input: HTMLInputElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event("input"));
    fixture.detectChanges();
  }

  function key(target: HTMLElement, key: string) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }

  function rowTexts(root: HTMLElement) {
    return Array.from(root.querySelectorAll(".lp-row")).map((row) => row.textContent?.trim());
  }

  it("toggles the active label from the keyboard", () => {
    const { fixture, root, input, toggled } = render(false, ["l-design"]);

    key(input, "ArrowDown");
    key(input, "ArrowDown");
    fixture.detectChanges();
    const active = root.querySelector(".lp-row.is-active")!;
    expect(active.textContent?.trim()).toBe("Design");
    expect(active.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(active.id);

    key(input, "Enter");
    expect(toggled).toEqual(["l-design"]);
    fixture.destroy();
  });

  it("highlights the search match in each label", () => {
    const { fixture, root, input } = render();
    type(fixture, input, "de");

    expect(rowTexts(root)).toEqual(["Design", "Tech debt"]);
    expect(Array.from(root.querySelectorAll(".lp-row mark")).map((mark) => mark.textContent)).toEqual(["De", "de"]);
    fixture.destroy();
  });

  it("never offers to create a label for viewers who cannot", () => {
    const { fixture, root, input } = render(false);
    type(fixture, input, "Urgent");

    expect(root.querySelector(".lp-create")).toBeNull();
    expect(root.querySelector(".lp-empty")).not.toBeNull();
    fixture.destroy();
  });

  it("offers to create a label for new text and creates it on Enter", () => {
    const { fixture, root, input, created, toggled } = render(true);
    type(fixture, input, "  Urgent ");

    expect(rowTexts(root)).toEqual(["Create label “Urgent”"]);
    expect(root.querySelector(".lp-empty")).toBeNull();
    // The only row, so typing armed it.
    expect(root.querySelector(".lp-create")!.classList.contains("is-active")).toBe(true);

    key(input, "Enter");
    fixture.detectChanges();
    expect(created).toEqual(["Urgent"]);
    expect(toggled).toEqual([]);
    expect(input.value).toBe("");
    expect(root.querySelector(".lp-create")).toBeNull();
    fixture.destroy();
  });

  it("puts the create row after partial matches, reachable with the arrows", () => {
    const { fixture, root, input, created, toggled } = render(true);
    type(fixture, input, "de");

    expect(rowTexts(root)).toEqual(["Design", "Tech debt", "Create label “de”"]);
    // Enter still prefers an existing label: the top hit is active first.
    expect(root.querySelector(".lp-row.is-active")!.textContent?.trim()).toBe("Design");

    key(input, "ArrowUp");
    fixture.detectChanges();
    expect(root.querySelector(".lp-row.is-active")!.classList.contains("lp-create")).toBe(true);
    key(input, "Enter");
    expect(created).toEqual(["de"]);
    expect(toggled).toEqual([]);
    fixture.destroy();
  });

  it("hides the create row when a label already has that name in any case", () => {
    const { fixture, root, input } = render(true);
    type(fixture, input, "tech DEBT");

    expect(rowTexts(root)).toEqual(["Tech debt"]);
    fixture.destroy();
  });

  it("creates from a click on the create row", () => {
    const { fixture, root, input, created } = render(true);
    type(fixture, input, "Urgent");

    root.querySelector<HTMLButtonElement>(".lp-create")!.click();
    expect(created).toEqual(["Urgent"]);
    fixture.destroy();
  });
});
