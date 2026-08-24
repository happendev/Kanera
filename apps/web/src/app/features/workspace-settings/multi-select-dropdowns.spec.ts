import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed, type ComponentFixture } from "@angular/core/testing";
import type { WireChecklistTemplate } from "@kanera/shared/events";
import { beforeEach, describe, expect, it } from "vitest";
import { ChecklistTemplateMultiSelectDropdownComponent } from "./checklist-template-multi-select-dropdown.component";
import { TokenMultiSelectDropdownComponent, type TokenMultiSelectOption } from "./token-multi-select-dropdown.component";
import { UserMultiSelectDropdownComponent, type UserMultiSelectOption } from "./user-multi-select-dropdown.component";

/**
 * These three dropdowns render their option list through the shared `k-picker-list`. Nothing
 * previously asserted their markup, which is what made swapping the list body a risk rather than a
 * refactor. These cover the contract each one owes: what rows it produces, how selection reads
 * back, and the toggle rules (`max`, `allowEmpty`) that live in the wrapper rather than the list.
 */

const USERS: UserMultiSelectOption[] = [
  { userId: "u1", displayName: "Ada Lovelace", email: "ada@example.com", avatarUrl: null },
  { userId: "u2", displayName: "Alan Turing", email: "alan@example.com", avatarUrl: null },
];

const TEMPLATES = [
  { id: "t1", title: "Launch checks", items: [{ id: "i1" }, { id: "i2" }] },
  { id: "t2", title: "Handover", items: [{ id: "i3" }] },
] as unknown as WireChecklistTemplate[];

const TOKENS: TokenMultiSelectOption[] = [
  { id: "l1", name: "Bug", color: "red" },
  { id: "l2", name: "Chore", color: null },
];

function open(fixture: ComponentFixture<unknown>) {
  const trigger = (fixture.nativeElement as HTMLElement).querySelector("button");
  trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  fixture.detectChanges();
}

function rowLabels(fixture: ComponentFixture<unknown>): string[] {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll(".pl-row .pl-label"))
    .map((node) => node.textContent?.trim() ?? "");
}

function rows(fixture: ComponentFixture<unknown>): HTMLElement[] {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll(".pl-row"));
}

describe("workspace settings multi-select dropdowns", () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] }).compileComponents();
  });

  describe("user multi-select", () => {
    function render(selectedIds: string[] = [], inputs: Record<string, unknown> = {}) {
      const fixture = TestBed.createComponent(UserMultiSelectDropdownComponent);
      fixture.componentRef.setInput("users", USERS);
      fixture.componentRef.setInput("selectedIds", selectedIds);
      for (const [key, value] of Object.entries(inputs)) fixture.componentRef.setInput(key, value);
      fixture.detectChanges();
      return fixture;
    }

    it("renders one row per user with the email as the secondary line", () => {
      const fixture = render();
      open(fixture);
      expect(rowLabels(fixture)).toEqual(["Ada Lovelace", "Alan Turing"]);
      const hints = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll(".pl-row .pl-text small"))
        .map((node) => node.textContent?.trim());
      expect(hints).toEqual(["ada@example.com", "alan@example.com"]);
    });

    it("marks the selected user and shows the search box even for a short list", () => {
      const fixture = render(["u2"]);
      open(fixture);
      expect(rows(fixture).map((row) => row.classList.contains("is-selected"))).toEqual([false, true]);
      expect((fixture.nativeElement as HTMLElement).querySelector(".pl-search")).not.toBeNull();
    });

    it("adds to the selection, and replaces it when max is 1", () => {
      const fixture = render(["u1"]);
      const emitted: string[][] = [];
      fixture.componentInstance.selectedIdsChange.subscribe((ids) => emitted.push(ids));
      open(fixture);
      rows(fixture)[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(emitted.at(-1)).toEqual(["u1", "u2"]);

      const single = render(["u1"], { max: 1 });
      const singleEmitted: string[][] = [];
      single.componentInstance.selectedIdsChange.subscribe((ids) => singleEmitted.push(ids));
      open(single);
      rows(single)[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(singleEmitted.at(-1)).toEqual(["u2"]);
    });

    it("refuses to empty the selection unless allowEmpty is set", () => {
      const fixture = render(["u1"]);
      const emitted: string[][] = [];
      fixture.componentInstance.selectedIdsChange.subscribe((ids) => emitted.push(ids));
      open(fixture);
      rows(fixture)[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(emitted).toEqual([]);

      const allowed = render(["u1"], { allowEmpty: true });
      const allowedEmitted: string[][] = [];
      allowed.componentInstance.selectedIdsChange.subscribe((ids) => allowedEmitted.push(ids));
      open(allowed);
      rows(allowed)[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(allowedEmitted.at(-1)).toEqual([]);
    });
  });

  describe("checklist template multi-select", () => {
    it("renders each template with a pluralised item count as trailing meta", () => {
      const fixture = TestBed.createComponent(ChecklistTemplateMultiSelectDropdownComponent);
      fixture.componentRef.setInput("templates", TEMPLATES);
      fixture.componentRef.setInput("selectedIds", []);
      fixture.detectChanges();
      open(fixture);
      expect(rowLabels(fixture)).toEqual(["Launch checks", "Handover"]);
      const trailing = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll(".pl-row .pl-trailing"))
        .map((node) => node.textContent?.trim());
      expect(trailing).toEqual(["2 items", "1 item"]);
    });
  });

  describe("token multi-select", () => {
    it("renders a colour dot per row, falling back to the neutral swatch when the token has no colour", () => {
      const fixture = TestBed.createComponent(TokenMultiSelectDropdownComponent);
      fixture.componentRef.setInput("options", TOKENS);
      fixture.componentRef.setInput("selectedIds", []);
      fixture.detectChanges();
      open(fixture);
      expect(rowLabels(fixture)).toEqual(["Bug", "Chore"]);
      const dots = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll(".pl-row .pl-dot"))
        .map((node) => (node as HTMLElement).style.background);
      expect(dots[0]).toContain("--color-red");
      expect(dots[1]).toContain("--border-strong");
    });

    it("hides the search box for a short vocabulary and shows it past the threshold", () => {
      const short = TestBed.createComponent(TokenMultiSelectDropdownComponent);
      short.componentRef.setInput("options", TOKENS);
      short.componentRef.setInput("selectedIds", []);
      short.detectChanges();
      open(short);
      expect((short.nativeElement as HTMLElement).querySelector(".pl-search")).toBeNull();

      const long = TestBed.createComponent(TokenMultiSelectDropdownComponent);
      long.componentRef.setInput("options", Array.from({ length: 8 }, (_, i) => ({ id: `l${i}`, name: `Label ${i}`, color: null })));
      long.componentRef.setInput("selectedIds", []);
      long.detectChanges();
      open(long);
      expect((long.nativeElement as HTMLElement).querySelector(".pl-search")).not.toBeNull();
    });
  });
});
