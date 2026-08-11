import { afterEach, describe, expect, it, vi } from "vitest";
import { openScratchpadPopoutWindow } from "./scratchpad-panel.component";

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
