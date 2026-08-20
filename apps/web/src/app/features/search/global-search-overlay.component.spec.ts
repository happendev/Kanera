import { provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import type { WireSearchResults } from "@kanera/shared/dto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalSearchService } from "../../core/search/global-search.service";
import { ThemeService } from "../../core/theme/theme.service";
import { GlobalSearchOverlayComponent } from "./global-search-overlay.component";

function emptyResults(overrides: Partial<WireSearchResults> = {}): WireSearchResults {
  return { cards: [], notes: [], comments: [], attachments: [], query: "x", ...overrides };
}

function key(name: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: name });
}

describe("GlobalSearchOverlayComponent", () => {
  let fixture: ComponentFixture<GlobalSearchOverlayComponent>;
  let component: GlobalSearchOverlayComponent;
  let search: {
    isOpen: ReturnType<typeof signal<boolean>>;
    query: ReturnType<typeof signal<string>>;
    results: ReturnType<typeof signal<WireSearchResults | null>>;
    loading: ReturnType<typeof signal<boolean>>;
    close: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
  };
  let router: { navigate: ReturnType<typeof vi.fn>; url: string };

  beforeEach(async () => {
    search = {
      isOpen: signal(true),
      query: signal("syn"),
      results: signal<WireSearchResults | null>(null),
      loading: signal(false),
      close: vi.fn(),
      open: vi.fn(),
    };
    router = { navigate: vi.fn(() => Promise.resolve(true)), url: "/" };

    await TestBed.configureTestingModule({
      imports: [GlobalSearchOverlayComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: GlobalSearchService, useValue: search },
        { provide: ThemeService, useValue: { theme: signal<"dark" | "light">("dark"), toggle: vi.fn() } },
        { provide: Router, useValue: router },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(GlobalSearchOverlayComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it("moves the highlight across the flattened result list and wraps", () => {
    search.results.set(
      emptyResults({
        cards: [
          { id: "c1", snippet: "a", workspaceId: "w1", workspaceName: "W", organisationKey: "0123456789ABCDEF", boardId: "b1", boardName: "B", boardIcon: null, boardColor: null, listName: "L", cardId: "c1", cardTitle: "Card 1", cardKey: "WORK-1" },
          { id: "c2", snippet: "b", workspaceId: "w1", workspaceName: "W", organisationKey: "0123456789ABCDEF", boardId: "b1", boardName: "B", boardIcon: null, boardColor: null, listName: "L", cardId: "c2", cardTitle: "Card 2", cardKey: "WORK-2" },
        ],
        notes: [
          { id: "n1", snippet: "n", workspaceId: "w1", workspaceName: "W", boardId: null, boardName: null, boardIcon: null, boardColor: null, title: "Note 1" },
        ],
      }),
    );
    fixture.detectChanges();

    expect(component.highlightedIndex()).toBe(0);
    component.onKeydown(key("ArrowDown"));
    expect(component.highlightedIndex()).toBe(1);
    component.onKeydown(key("ArrowDown"));
    expect(component.highlightedIndex()).toBe(2);
    component.onKeydown(key("ArrowDown")); // wraps to start
    expect(component.highlightedIndex()).toBe(0);
    component.onKeydown(key("ArrowUp")); // wraps to end
    expect(component.highlightedIndex()).toBe(2);
  });

  it("exposes the highlighted result through combobox and option aria attributes", () => {
    search.results.set(
      emptyResults({
        cards: [
          { id: "c1", snippet: "a", workspaceId: "w1", workspaceName: "W", organisationKey: "0123456789ABCDEF", boardId: "b1", boardName: "B", boardIcon: null, boardColor: null, listName: "L", cardId: "c1", cardTitle: "Card 1", cardKey: "WORK-1" },
          { id: "c2", snippet: "b", workspaceId: "w1", workspaceName: "W", organisationKey: "0123456789ABCDEF", boardId: "b1", boardName: "B", boardIcon: null, boardColor: null, listName: "L", cardId: "c2", cardTitle: "Card 2", cardKey: "WORK-2" },
        ],
      }),
    );
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const input = host.querySelector<HTMLInputElement>(".search-input")!;
    const options = [...host.querySelectorAll<HTMLButtonElement>(".row")];
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-controls")).toBe("global-search-results");
    expect(input.getAttribute("aria-activedescendant")).toBe("global-search-result-0");
    expect(options[0]?.getAttribute("role")).toBe("option");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");

    component.onKeydown(key("ArrowDown"));
    fixture.detectChanges();

    expect(input.getAttribute("aria-activedescendant")).toBe("global-search-result-1");
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("opens a card result on its canonical board path", () => {
    component.select({
      kind: "card",
      data: { id: "c1", snippet: "a", workspaceId: "w1", workspaceName: "W", organisationKey: "0123456789ABCDEF", boardId: "b1", boardName: "B", boardIcon: null, boardColor: null, listName: "L", cardId: "c1", cardTitle: "Card 1", cardKey: "WORK-1" },
    });
    expect(router.navigate).toHaveBeenCalledWith(["/b", "b1", "c", "c1"], { browserUrl: "/o/0123456789ABCDEF/c/WORK-1" });
    expect(search.close).toHaveBeenCalled();
  });

  it("opens a workspace-level note on the workspace notes page", () => {
    component.select({
      kind: "note",
      data: { id: "n1", snippet: "n", workspaceId: "w1", workspaceName: "W", boardId: null, boardName: null, boardIcon: null, boardColor: null, title: "Note 1" },
    });
    expect(router.navigate).toHaveBeenCalledWith(["/w", "w1", "notes"], { queryParams: { noteId: "n1" } });
  });

  it("opens a board-scoped note in the board notes view", () => {
    component.select({
      kind: "note",
      data: { id: "n2", snippet: "n", workspaceId: "w1", workspaceName: "W", boardId: "b1", boardName: "B", boardIcon: null, boardColor: null, title: "Note 2" },
    });
    expect(router.navigate).toHaveBeenCalledWith(["/b", "b1"], { queryParams: { view: "notes", noteId: "n2" } });
  });

  it("offers contextual commands before a search and runs them from the same keyboard list", async () => {
    search.query.set("");
    router.url = "/b/board-1";
    await fixture.whenStable();

    expect(component.commands()[0]?.label).toBe("Create a new card");
    expect(component.flat()[0]?.kind).toBe("command");

    component.onKeydown(key("Enter"));
    expect(search.close).toHaveBeenCalled();
  });

  it("shows quick actions only while the search is empty", async () => {
    search.query.set("");
    await fixture.whenStable();
    expect(component.commands().length).toBeGreaterThan(1);

    search.query.set(">");
    await fixture.whenStable();
    expect(component.commands()).toEqual([]);
  });

  it("opens a comment result on the parent card", () => {
    component.select({
      kind: "comment",
      data: { id: "cm1", snippet: "hi", workspaceId: "w1", workspaceName: "W", organisationKey: "0123456789ABCDEF", boardId: "b1", boardName: "B", boardIcon: null, boardColor: null, listName: "L", cardId: "c9", cardTitle: "Card 9", cardKey: "WORK-9" },
    });
    expect(router.navigate).toHaveBeenCalledWith(["/b", "b1", "c", "c9"], { browserUrl: "/o/0123456789ABCDEF/c/WORK-9" });
  });
});
