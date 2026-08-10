import { describe, expect, it, vi } from "vitest";
import { UnsavedWorkService } from "./unsaved-work.service";

describe("UnsavedWorkService", () => {
  it("uses the native beforeunload safeguard while work is dirty", () => {
    const service = new UnsavedWorkService();
    const source = Symbol("editor");
    service.setDirty(source, true);

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    service.ngOnDestroy();
  });

  it("confirms in-app navigation only when work is dirty", () => {
    const service = new UnsavedWorkService();
    const source = Symbol("editor");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    expect(service.confirmNavigation()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();

    service.setDirty(source, true);
    expect(service.confirmNavigation()).toBe(false);
    expect(confirm).toHaveBeenCalledWith("You have unsaved work. Are you sure you want to leave?");

    service.setDirty(source, false);
    expect(service.confirmNavigation()).toBe(true);
    service.ngOnDestroy();
  });

  // A close gesture asks, and Angular's canDeactivate guard asks again for the navigation that
  // gesture starts. Accepting the first prompt has to settle the question for both.
  it("asks once per gesture: accepting drops the dirty work so the route guard does not re-ask", () => {
    const service = new UnsavedWorkService();
    const source = Symbol("card-description-editor");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    confirm.mockClear();
    service.setDirty(source, true);

    expect(service.confirmNavigation()).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();

    // Stands in for the route guard running on the resulting URL change.
    expect(service.confirmNavigation()).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(service.hasUnsavedWork()).toBe(false);
    service.ngOnDestroy();
  });

  it("keeps the work dirty when the user cancels", () => {
    const service = new UnsavedWorkService();
    const source = Symbol("card-description-editor");
    vi.spyOn(window, "confirm").mockReturnValue(false);
    service.setDirty(source, true);

    expect(service.confirmNavigation()).toBe(false);
    expect(service.hasUnsavedWork()).toBe(true);
    expect(service.isDirty(source)).toBe(true);
    service.ngOnDestroy();
  });

  it("confirm and isDirty let a caller scope a prompt to a single editor, ignoring unrelated ones", () => {
    const service = new UnsavedWorkService();
    const drawerEditor = Symbol("checklist-item-editor");
    const otherEditor = Symbol("card-description-editor");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    confirm.mockClear();

    // An unrelated dirty editor must not gate closing the clean drawer.
    service.setDirty(otherEditor, true);
    expect(service.isDirty(drawerEditor)).toBe(false);
    expect(service.confirm(service.isDirty(drawerEditor))).toBe(true);
    expect(confirm).not.toHaveBeenCalled();

    // Once the drawer's own editor is dirty, closing prompts.
    service.setDirty(drawerEditor, true);
    expect(service.confirm(service.isDirty(drawerEditor))).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();

    service.ngOnDestroy();
  });
});
