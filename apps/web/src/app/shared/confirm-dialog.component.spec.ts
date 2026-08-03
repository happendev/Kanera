import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialogComponent } from "./confirm-dialog.component";

describe("ConfirmDialogComponent", () => {
  it("keeps destructive confirmation disabled until the exact name is entered", async () => {
    await TestBed.configureTestingModule({
      imports: [ConfirmDialogComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    const fixture = TestBed.createComponent(ConfirmDialogComponent);
    fixture.componentRef.setInput("title", "Delete workspace?");
    fixture.componentRef.setInput("confirmationText", "Delivery");
    fixture.detectChanges();
    const confirmed = vi.fn();
    fixture.componentInstance.result.subscribe(confirmed);
    const button = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.includes("Delete"))!;

    expect(button.disabled).toBe(true);
    fixture.componentInstance.enteredText.set("delivery");
    fixture.detectChanges();
    button.click();
    expect(confirmed).not.toHaveBeenCalled();

    fixture.componentInstance.enteredText.set("Delivery");
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    button.click();
    expect(confirmed).toHaveBeenCalledWith(true);
  });
});
