import type { AfterViewInit, ElementRef, OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, ViewChild, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { environment } from "../../../environments/environment";
import { LogoComponent } from "../../shared/logo.component";

interface AuthConfigResponse {
  turnstileSiteKey: string | null;
}

@Component({
  selector: "k-forgot-password",
  standalone: true,
  imports: [RouterLink, LogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./forgot-password.page.html",
  styleUrl: "./login.page.scss",
})
export class ForgotPasswordPage implements OnInit, AfterViewInit {
  readonly email = signal("");
  readonly sent = signal(false);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly turnstileSiteKey = signal<string | null>(null);
  readonly turnstileToken = signal<string | null>(null);
  private turnstileElement: HTMLElement | null = null;
  private turnstileWidgetId: string | null = null;
  private viewReady = false;

  @ViewChild("turnstileContainer")
  set turnstileContainer(container: ElementRef<HTMLElement> | undefined) {
    const next = container?.nativeElement ?? null;
    if (this.turnstileElement === next) return;
    this.turnstileElement = next;
    this.turnstileWidgetId = null;
    this.loadTurnstile();
  }

  ngOnInit() {
    void fetch(`${environment.apiUrl}/auth/config`, { credentials: "include" })
      .then(async (res) => (res.ok ? parseAuthConfigResponse(await res.json()) : { turnstileSiteKey: null }))
      .then((config) => {
        this.turnstileSiteKey.set(config.turnstileSiteKey);
        this.loadTurnstile();
      })
      .catch(() => this.turnstileSiteKey.set(null));
  }

  async submit(e: Event) {
    e.preventDefault();
    const email = this.email().trim();

    this.error.set(null);
    this.sent.set(false);
    this.error.set(validateEmail(email));
    if (this.error()) return;
    if (!this.ensureTurnstileSolved()) return;

    this.busy.set(true);
    try {
      const res = await fetch(`${environment.apiUrl}/auth/forgot-password`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          ...(this.turnstileToken() ? { turnstileToken: this.turnstileToken() } : {}),
        }),
      });
      if (!res.ok) {
        this.error.set("We could not create a reset link. Check the email and try again.");
        this.resetTurnstile();
        return;
      }
      this.sent.set(true);
      this.resetTurnstile();
    } catch {
      this.error.set("We could not create a reset link. Check your connection and try again.");
      this.resetTurnstile();
    } finally {
      this.busy.set(false);
    }
  }

  ngAfterViewInit() {
    this.viewReady = true;
    this.loadTurnstile();
  }

  private ensureTurnstileSolved(): boolean {
    if (!this.turnstileSiteKey()) return true;
    if (this.turnstileToken()) return true;
    this.error.set("Complete the security check to continue.");
    return false;
  }

  private loadTurnstile() {
    if (!this.turnstileSiteKey() || !this.viewReady) return;
    if (window.turnstile) {
      this.renderTurnstile();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>('script[data-kanera-turnstile="true"]');
    if (existing) {
      existing.addEventListener("load", () => this.renderTurnstile(), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset["kaneraTurnstile"] = "true";
    script.addEventListener("load", () => this.renderTurnstile(), { once: true });
    script.addEventListener("error", () => this.error.set("Security check could not load. Try refreshing the page."), { once: true });
    document.head.appendChild(script);
  }

  private renderTurnstile() {
    const siteKey = this.turnstileSiteKey();
    const element = this.turnstileElement;
    if (!siteKey || !element || !window.turnstile || this.turnstileWidgetId) return;
    this.turnstileWidgetId = window.turnstile.render(element, {
      sitekey: siteKey,
      callback: (token: string) => {
        this.turnstileToken.set(token);
        if (this.error() === "Complete the security check to continue.") this.error.set(null);
      },
      "expired-callback": () => this.turnstileToken.set(null),
      "error-callback": () => {
        this.turnstileToken.set(null);
        this.error.set("Security check failed. Try again.");
      },
    });
  }

  private resetTurnstile() {
    this.turnstileToken.set(null);
    if (this.turnstileWidgetId && window.turnstile) {
      window.turnstile.reset(this.turnstileWidgetId);
    }
  }
}

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
      reset: (widgetId: string) => void;
    };
  }
}

interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
}

function parseAuthConfigResponse(value: unknown): AuthConfigResponse {
  if (!value || typeof value !== "object") throw new Error("Invalid auth config response");
  const config = value as Partial<AuthConfigResponse>;
  if (typeof config.turnstileSiteKey !== "string" && config.turnstileSiteKey !== null) throw new Error("Invalid auth config response");
  return { turnstileSiteKey: config.turnstileSiteKey };
}

function validateEmail(email: string): string | null {
  if (!email) return "Email is required.";
  if (email.length > 254) return "Email must be 254 characters or fewer.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
  return null;
}
