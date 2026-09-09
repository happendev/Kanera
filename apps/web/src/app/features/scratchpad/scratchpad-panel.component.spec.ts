import { afterEach, describe, expect, it, vi } from "vitest";
import { computed, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { ScratchpadService } from "./scratchpad.service";
import { ScratchpadPanelComponent, openScratchpadPopoutWindow } from "./scratchpad-panel.component";

describe("openScratchpadPopoutWindow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens another top-level window when the app is installed in standalone mode", () => {
    const popped = {} as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(popped);
    const matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
    vi.stubGlobal("matchMedia", matchMedia);

    expect(openScratchpadPopoutWindow("/scratchpad")).toBe(popped);
    expect(open).toHaveBeenCalledWith("/scratchpad", "kanera-scratchpad");
    // Standalone mode must not short-circuit window creation; it represents an app window, not an
    // inability to create another top-level browsing context.
    expect(matchMedia).not.toHaveBeenCalled();
  });
});

describe("scratchpad editor lifetime", () => {
  afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

  it("re-seeds a reopened editor without changing the seed during typing", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const open = signal(true);
    const notes = signal([{ id: "note-1", content: "Original text" }]);
    await TestBed.configureTestingModule({
      imports: [ScratchpadPanelComponent],
      providers: [provideRouter([]), { provide: ScratchpadService, useValue: {
        open, setOpen: (value: boolean) => open.set(value), notes, activeNote: computed(() => notes()[0]), activeNoteId: signal("note-1"),
        initialise: vi.fn(), recoveredMarkdown: vi.fn(() => null), registerEditor: vi.fn(), flushAll: vi.fn(),
      } }],
    }).overrideComponent(ScratchpadPanelComponent, { set: {
      imports: [], template: '@if (visible()) { <span>{{ editorSeed()?.value }}</span> }',
    } }).compileComponents();
    const fixture = TestBed.createComponent(ScratchpadPanelComponent);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("Original text");
    notes.set([{ id: "note-1", content: "Saved edit" }]);
    await fixture.whenStable();
    expect(root.textContent).toContain("Original text");
    open.set(false);
    await fixture.whenStable();
    open.set(true);
    await fixture.whenStable();
    expect(root.textContent).toContain("Saved edit");
  });
});
