import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_DOM_EVENTS, STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { PanelStackService } from "../../shared/panel-stack.service";
import { BoardMenuCoordinator } from "./board-menu-coordinator.service";

/**
 * Constructed inside an injection context rather than with a bare `new`: the coordinator now injects
 * the root `CardLabelDisplayService` that owns the label-display preference.
 */
const create = () => TestBed.runInInjectionContext(() => new BoardMenuCoordinator());

describe("BoardMenuCoordinator", () => {
  let coordinator: BoardMenuCoordinator | null = null;

  afterEach(() => {
    coordinator?.ngOnDestroy();
    coordinator = null;
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it("closes context menus and nested pickers when a drag starts", () => {
    coordinator = create();
    const open = signal(false);
    coordinator.registerCardMenu("card-1", open);
    coordinator.openCardMenu("card-1");
    const panels = TestBed.inject(PanelStackService);
    const host = document.createElement("div");
    const nested = document.createElement("div");
    host.append(nested);
    const dismiss = vi.fn();
    const dismissNested = vi.fn();
    panels.register({ hostEl: host, dismiss });
    panels.register({ hostEl: nested, dismiss: dismissNested });
    document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: true }));
    expect(open()).toBe(false);
    expect(panels.depth).toBe(0);
    expect(dismiss).toHaveBeenCalledWith("superseded");
    expect(dismissNested).toHaveBeenCalledWith("superseded");
    coordinator.openListMenu("list-1");
    document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: false }));
    expect(coordinator.activeListMenuId()).toBe("list-1");
    coordinator.closeMenusForDrag();
    expect(coordinator.activeListMenuId()).toBeNull();
  });

  it("keeps card and list menus mutually exclusive without per-tile listeners", () => {
    coordinator = create();
    const firstCardOpen = signal(false);
    const secondCardOpen = signal(false);
    coordinator.registerCardMenu("card-1", firstCardOpen);
    coordinator.registerCardMenu("card-2", secondCardOpen);
    coordinator.openCardMenu("card-1");
    expect(coordinator.activeCardMenuId()).toBe("card-1");
    expect(coordinator.activeListMenuId()).toBeNull();
    expect(firstCardOpen()).toBe(true);
    expect(secondCardOpen()).toBe(false);

    coordinator.openCardMenu("card-2");
    expect(firstCardOpen()).toBe(false);
    expect(secondCardOpen()).toBe(true);

    coordinator.openListMenu("list-1");
    expect(coordinator.activeCardMenuId()).toBeNull();
    expect(coordinator.activeListMenuId()).toBe("list-1");
    expect(secondCardOpen()).toBe(false);
  });

  it("bridges legacy card-menu view events through one shared listener", () => {
    coordinator = create();
    coordinator.openListMenu("list-2");
    expect(coordinator.activeListMenuId()).toBe("list-2");

    // The list/calendar views open card menus via this DOM event; the bridge must apply the same
    // mutual exclusion as a direct openCardMenu call and close the active list menu.
    document.dispatchEvent(new CustomEvent<string>(APP_DOM_EVENTS.CARD_ACTIONS_MENU_OPEN, { detail: "card-2" }));
    expect(coordinator.activeCardMenuId()).toBe("card-2");
    expect(coordinator.activeListMenuId()).toBeNull();
  });

  // Delegated to the root CardLabelDisplayService, which is what lets shell chrome outside any
  // board route render the same chips. The coordinator keeps the accessors its call sites use.
  it("delegates the shared label-display preference", () => {
    coordinator = create();
    coordinator.setLabelsCompressed(true);
    expect(coordinator.labelsCompressed()).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.CARD_LABELS_COMPRESSED)).toBe("1");

    window.dispatchEvent(new StorageEvent("storage", {
      key: STORAGE_KEYS.CARD_LABELS_COMPRESSED,
      newValue: null,
    }));
    expect(coordinator.labelsCompressed()).toBe(false);
  });
});
