import { signal } from "@angular/core";
import { afterEach, describe, expect, it } from "vitest";
import { APP_DOM_EVENTS, STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { BoardMenuCoordinator } from "./board-menu-coordinator.service";

describe("BoardMenuCoordinator", () => {
  let coordinator: BoardMenuCoordinator | null = null;

  afterEach(() => {
    coordinator?.ngOnDestroy();
    coordinator = null;
    localStorage.clear();
  });

  it("keeps card and list menus mutually exclusive without per-tile listeners", () => {
    coordinator = new BoardMenuCoordinator();
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
    coordinator = new BoardMenuCoordinator();
    coordinator.openListMenu("list-2");
    expect(coordinator.activeListMenuId()).toBe("list-2");

    // The list/calendar views open card menus via this DOM event; the bridge must apply the same
    // mutual exclusion as a direct openCardMenu call and close the active list menu.
    document.dispatchEvent(new CustomEvent<string>(APP_DOM_EVENTS.CARD_ACTIONS_MENU_OPEN, { detail: "card-2" }));
    expect(coordinator.activeCardMenuId()).toBe("card-2");
    expect(coordinator.activeListMenuId()).toBeNull();
  });

  it("owns the shared label-display preference", () => {
    coordinator = new BoardMenuCoordinator();
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
