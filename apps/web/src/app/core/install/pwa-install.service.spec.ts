import { describe, expect, it, vi } from "vitest";
import { PwaInstallService } from "./pwa-install.service";

describe("PwaInstallService", () => {
  it("defers the Chromium install prompt until a user action and clears it after installation", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false } as MediaQueryList)));
    const service = new PwaInstallService();
    service.init();
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome: "accepted" }) });

    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(service.canPrompt()).toBe(true);
    expect(prompt).not.toHaveBeenCalled();

    await service.prompt();
    expect(prompt).toHaveBeenCalledOnce();
    expect(service.canPrompt()).toBe(false);

    window.dispatchEvent(new Event("appinstalled"));
    expect(service.installed()).toBe(true);
    vi.unstubAllGlobals();
  });
});
