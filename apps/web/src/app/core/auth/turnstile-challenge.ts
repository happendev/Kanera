import { signal, type WritableSignal } from "@angular/core";

interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
}

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
      reset: (widgetId: string) => void;
    };
  }
}

/** Per-page challenge state; only the external script is shared between auth pages. */
export class TurnstileChallenge {
  readonly siteKey = signal<string | null>(null);
  readonly token = signal<string | null>(null);
  private element: HTMLElement | null = null;
  private widgetId: string | null = null;
  private viewReady = false;

  constructor(
    private readonly error: WritableSignal<string | null>,
    private readonly onSolved?: () => void,
  ) {}

  setElement(element: HTMLElement | null) {
    if (this.element === element) return;
    this.element = element;
    this.widgetId = null;
    this.load();
  }

  initialize() {
    this.viewReady = true;
    this.load();
  }

  ensureSolved(): boolean {
    if (!this.siteKey() || this.token()) return true;
    this.error.set("Complete the security check to continue.");
    return false;
  }

  load() {
    if (!this.siteKey() || !this.viewReady) return;
    if (window.turnstile) {
      this.render();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>('script[data-kanera-turnstile="true"]');
    if (existing) {
      existing.addEventListener("load", () => this.render(), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset["kaneraTurnstile"] = "true";
    script.addEventListener("load", () => this.render(), { once: true });
    script.addEventListener("error", () => this.error.set("Security check could not load. Try refreshing the page."), { once: true });
    document.head.appendChild(script);
  }

  private render() {
    const siteKey = this.siteKey();
    if (!siteKey || !this.element || !window.turnstile || this.widgetId) return;
    this.widgetId = window.turnstile.render(this.element, {
      sitekey: siteKey,
      callback: (token) => {
        this.token.set(token);
        this.onSolved?.();
        if (this.error() === "Complete the security check to continue.") this.error.set(null);
      },
      "expired-callback": () => this.token.set(null),
      "error-callback": () => {
        this.token.set(null);
        this.error.set("Security check failed. Try again.");
      },
    });
  }

  reset() {
    this.token.set(null);
    if (this.widgetId && window.turnstile) window.turnstile.reset(this.widgetId);
  }
}
