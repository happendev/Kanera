import type { AfterViewInit, ElementRef, OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, ViewChild, computed, inject, signal } from "@angular/core";
import { disabled, form, FormField, submit, validate } from "@angular/forms/signals";
import { RouterLink } from "@angular/router";
import { PublicAuthClient } from "../../core/auth/public-auth.client";
import { TurnstileChallenge } from "../../core/auth/turnstile-challenge";
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
  private readonly turnstile = new TurnstileChallenge(this.workflowError);
  readonly turnstileSiteKey = this.turnstile.siteKey;
  readonly turnstileToken = this.turnstile.token;

  @ViewChild("turnstileContainer")
  set turnstileContainer(container: ElementRef<HTMLElement> | undefined) {
    this.turnstile.setElement(container?.nativeElement ?? null);
  }

  ngOnInit() {
    void this.publicAuth.get("/auth/config")
      .then(async (res) => (res.ok ? parseAuthConfigResponse(await res.json()) : { turnstileSiteKey: null }))
      .then((config) => {
        this.turnstileSiteKey.set(config.turnstileSiteKey);
        this.turnstile.load();
      })
      .catch(() => this.turnstileSiteKey.set(null));
  }

  submit(e: Event) {
    e.preventDefault();
    this.sent.set(false);
    this.workflowError.set(null);
    return submit(this.forgotPasswordForm, async () => {
      if (!this.turnstile.ensureSolved()) return undefined;
      try {
        const res = await this.publicAuth.post("/auth/forgot-password", {
          email: this.email().trim(),
          ...(this.turnstileToken() ? { turnstileToken: this.turnstileToken() } : {}),
        });
        if (!res.ok) {
          this.turnstile.reset();
          return { kind: "server", message: "We could not create a reset link. Check the email and try again." };
        }
        this.sent.set(true);
        this.turnstile.reset();
        return undefined;
      } catch {
        this.turnstile.reset();
        return { kind: "server", message: "We could not create a reset link. Check your connection and try again." };
      }
    });
  }

  ngAfterViewInit() {
    this.turnstile.initialize();
  }

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
