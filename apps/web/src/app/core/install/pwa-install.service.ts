import { Injectable, signal } from "@angular/core";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

@Injectable({ providedIn: "root" })
export class PwaInstallService {
  readonly canPrompt = signal(false);
  readonly installed = signal(false);
  private deferredPrompt: InstallPromptEvent | null = null;
  private initialized = false;

  init(): void {
    if (this.initialized || typeof window === "undefined") return;
    this.initialized = true;
    this.installed.set(
      window.matchMedia("(display-mode: standalone)").matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    );
    window.addEventListener("beforeinstallprompt", (event) => {
      // Chromium owns the prompt event. Defer it until the user selects Install in the account menu.
      event.preventDefault();
      this.deferredPrompt = event as InstallPromptEvent;
      this.canPrompt.set(true);
    });
    window.addEventListener("appinstalled", () => {
      this.deferredPrompt = null;
      this.canPrompt.set(false);
      this.installed.set(true);
    });
  }

  async prompt(): Promise<void> {
    const event = this.deferredPrompt;
    if (!event) return;
    // The browser permits one prompt() call per event. A later event can make Install available again.
    this.deferredPrompt = null;
    this.canPrompt.set(false);
    await event.prompt();
    await event.userChoice;
  }
}
