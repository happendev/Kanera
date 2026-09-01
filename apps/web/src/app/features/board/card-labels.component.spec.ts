import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { CardLabelsComponent } from "./card-labels.component";

describe("CardLabelsComponent", () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  it("stays expanded when a dense view opts out of the shared compression preference", async () => {
    localStorage.setItem(STORAGE_KEYS.CARD_LABELS_COMPRESSED, "1");
    const fixture = TestBed.createComponent(CardLabelsComponent);
    fixture.componentRef.setInput("labels", [{ id: "label-1", name: "Urgent", color: "red" }]);
    fixture.componentRef.setInput("interactive", false);
    fixture.componentRef.setInput("alwaysExpanded", true);

    await fixture.whenStable();

    const host = fixture.nativeElement as HTMLElement;
    const chip = host.querySelector(".label-chip") as HTMLElement;
    expect(chip.classList.contains("is-compressed")).toBe(false);
    expect(chip.textContent?.trim()).toBe("Urgent");

    chip.click();
    expect(localStorage.getItem(STORAGE_KEYS.CARD_LABELS_COMPRESSED)).toBe("1");
  });
});
