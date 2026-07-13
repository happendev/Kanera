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
});
