import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { ComponentFixture } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import type { PickerGroup } from "../../../shared/picker-list.component";
import { AutomationSelectDropdownComponent } from "./automation-select-dropdown.component";

const GROUPS: PickerGroup[] = [
  {
    id: "movement",
    label: "Movement",
    options: [
      { id: "enters", label: "Card enters a list", hint: "Created in or moved into a list", icon: "login-2" },
      { id: "leaves", label: "Card leaves a list", hint: "Moved out of a list", icon: "logout-2" },
    ],
  },
];

describe("AutomationSelectDropdownComponent", () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AutomationSelectDropdownComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  function render(value = "enters"): ComponentFixture<AutomationSelectDropdownComponent> {
    const fixture = TestBed.createComponent(AutomationSelectDropdownComponent);
    fixture.componentRef.setInput("groups", GROUPS);
    fixture.componentRef.setInput("value", value);
    fixture.componentRef.setInput("ariaLabel", "Event");
    fixture.detectChanges();
    return fixture;
  }

  it("shows the selected option and exposes the field name to assistive technology", () => {
    const fixture = render();
    const trigger = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".asd-trigger")!;

    expect(trigger.textContent).toContain("Card enters a list");
    expect(trigger.getAttribute("aria-label")).toBe("Event: Card enters a list");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fixture.destroy();
  });

  it("opens the descriptive picker, commits one choice and closes", async () => {
    const fixture = render();
    const values: string[] = [];
    fixture.componentInstance.valueChange.subscribe(value => values.push(value));

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".asd-trigger")!.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.open()).toBe(true);
    const rows = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(".pl-row"));
    expect(rows.map(row => row.textContent?.trim())).toEqual([
      "Card enters a listCreated in or moved into a list",
      "Card leaves a listMoved out of a list",
    ]);

    rows[1]!.click();
    fixture.detectChanges();

    expect(values).toEqual(["leaves"]);
    expect(fixture.componentInstance.open()).toBe(false);
    fixture.destroy();
  });
});
