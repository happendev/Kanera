import type { AfterViewInit, ElementRef, OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, ViewChild, computed, inject, signal } from "@angular/core";
import { disabled, form, FormField, submit, validate } from "@angular/forms/signals";
import { RouterLink } from "@angular/router";
import { PublicAuthClient } from "../../core/auth/public-auth.client";
import { LogoComponent } from "../../shared/logo.component";

interface AuthConfigResponse {
  turnstileSiteKey: string | null;
}

@Component({
  selector: "k-forgot-password",
  standalone: true,
  imports: [RouterLink, LogoComponent, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./forgot-password.page.html",
  styleUrl: "./login.page.scss",
})
export class ForgotPasswordPage implements OnInit, AfterViewInit {
  private readonly publicAuth = inject(PublicAuthClient);
  readonly forgotPasswordModel = signal({ email: "" });
  readonly forgotPasswordForm = form(this.forgotPasswordModel, (passwordReset) => {
    validate(passwordReset.email, ({ value }) => validationError(validateEmail(value().trim())));
    disabled(passwordReset.email, { when: ({ state }) => state.submitting() });
  });
  readonly email = this.forgotPasswordForm.email().value;
  readonly sent = signal(false);
  private readonly workflowError = signal<string | null>(null);
  readonly error = computed(() => this.workflowError() ?? touchedFormError(this.forgotPasswordForm));
  readonly busy = computed(() => this.forgotPasswordForm().submitting());
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
    void this.publicAuth.get("/auth/config")
      .then(async (res) => (res.ok ? parseAuthConfigResponse(await res.json()) : { turnstileSiteKey: null }))
      .then((config) => {
        this.turnstileSiteKey.set(config.turnstileSiteKey);
        this.loadTurnstile();
      })
      .catch(() => this.turnstileSiteKey.set(null));
  }

  submit(e: Event) {
    e.preventDefault();
    this.sent.set(false);
    this.workflowError.set(null);
    return submit(this.forgotPasswordForm, async () => {
      if (!this.ensureTurnstileSolved()) return undefined;
      try {
        const res = await this.publicAuth.post("/auth/forgot-password", {
          email: this.email().trim(),
          ...(this.turnstileToken() ? { turnstileToken: this.turnstileToken() } : {}),
        });
        if (!res.ok) {
          this.resetTurnstile();
          return { kind: "server", message: "We could not create a reset link. Check the email and try again." };
        }
        this.sent.set(true);
        this.resetTurnstile();
        return undefined;
      } catch {
        this.resetTurnstile();
        return { kind: "server", message: "We could not create a reset link. Check your connection and try again." };
      }
    });
  }

  ngAfterViewInit() {
    this.viewReady = true;
    this.loadTurnstile();
  }

  private ensureTurnstileSolved(): boolean {
    if (!this.turnstileSiteKey()) return true;
    if (this.turnstileToken()) return true;
    this.workflowError.set("Complete the security check to continue.");
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
    script.addEventListener("error", () => this.workflowError.set("Security check could not load. Try refreshing the page."), { once: true });
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
        if (this.workflowError() === "Complete the security check to continue.") this.workflowError.set(null);
      },
      "expired-callback": () => this.turnstileToken.set(null),
      "error-callback": () => {
        this.turnstileToken.set(null);
        this.workflowError.set("Security check failed. Try again.");
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

function validationError(message: string | null) {
  return message ? { kind: "validation", message } : undefined;
}

function touchedFormError(formTree: () => { touched(): boolean; errorSummary(): readonly { message?: string }[] }): string | null {
  return formTree().touched() ? formTree().errorSummary()[0]?.message ?? null : null;
}
