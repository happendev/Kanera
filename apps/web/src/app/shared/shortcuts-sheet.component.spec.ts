import { provideZonelessChangeDetection } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { KeyboardShortcutsService, formatShortcut } from "../core/keyboard/keyboard-shortcuts.service";
import { ShortcutsSheetComponent } from "./shortcuts-sheet.component";

describe("ShortcutsSheetComponent", () => {
  let fixture: ComponentFixture<ShortcutsSheetComponent>;
  let host: HTMLElement;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ShortcutsSheetComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    const shortcuts = TestBed.inject(KeyboardShortcutsService);
    shortcuts.registerAll("Everywhere", [
      { keys: "mod+k", label: "Search Kanera", run: () => undefined },
      { keys: "?", label: "Keyboard shortcuts", run: () => undefined },
    ]);
    shortcuts.registerAll("Go to", [
      { keys: "g h", label: "Go home", run: () => undefined },
      { keys: "g w", label: "Global Work", run: () => undefined },
    ]);

    fixture = TestBed.createComponent(ShortcutsSheetComponent);
    fixture.detectChanges();
    host = fixture.nativeElement as HTMLElement;
  });

  it("filters shortcuts by action label and shows only groups with matches", () => {
    fixture.componentInstance.query.set("home");
    fixture.detectChanges();

    expect([...host.querySelectorAll(".ks-group h3")].map((heading) => heading.textContent?.trim())).toEqual(["Go to"]);
    expect([...host.querySelectorAll(".ks-label")].map((label) => label.textContent?.trim())).toEqual(["Go home"]);
  });

  it("matches section names and key labels", () => {
    fixture.componentInstance.query.set("go to");
    fixture.detectChanges();
    expect(host.querySelectorAll(".ks-row")).toHaveLength(2);

    fixture.componentInstance.query.set(formatShortcut("mod+k")[0]![0]!);
    fixture.detectChanges();
    expect(host.querySelectorAll(".ks-row")).toHaveLength(1);
    expect(host.querySelector(".ks-label")?.textContent?.trim()).toBe("Search Kanera");
  });

  it("renders a useful empty state and clears the search", () => {
    fixture.componentInstance.query.set("does not exist");
    fixture.detectChanges();

    expect(host.querySelector(".ks-empty")?.textContent).toContain("No shortcuts match");
    host.querySelector<HTMLButtonElement>(".ks-empty button")?.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.query()).toBe("");
    expect(host.querySelectorAll(".ks-row")).toHaveLength(4);
  });
});
