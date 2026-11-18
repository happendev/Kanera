import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import type { SignInProvider } from "@kanera/shared/schema";
import type { ProviderAuthPage } from "../../core/analytics/analytics-events";
import { AnalyticsService } from "../../core/analytics/analytics.service";
import { signupAcquisition } from "../../core/analytics/signup-attribution";
import { PublicAuthClient } from "../../core/auth/public-auth.client";
import { CookieConsentService } from "../../core/consent/cookie-consent.service";
import { appLocale } from "../../core/i18n/locale";

const PROVIDER_ORDER: readonly SignInProvider[] = ["google", "microsoft", "github"];
export const PROVIDER_ICONS: Record<SignInProvider, string> = { google: "ti-brand-google", microsoft: "ti-brand-windows", github: "ti-brand-github" };
// Brand names are never translated.
export const PROVIDER_NAMES: Record<SignInProvider, string> = { google: "Google", microsoft: "Microsoft", github: "GitHub" };

let providersRequest: Promise<SignInProvider[]> | null = null;

/** The callback's `provider` query value, accepted only when it names a known provider. */
export function knownSignInProvider(value: string | null | undefined): SignInProvider | undefined {
  return PROVIDER_ORDER.find((provider) => provider === value);
}

/** /auth/config is static per deployment, so every auth page on screen shares one request. */
export function loadSignInProviders(client: PublicAuthClient): Promise<SignInProvider[]> {
  providersRequest ??= client.get("/auth/config")
    .then(async (res) => {
      if (!res.ok) return [];
      const body = await res.json() as { signInProviders?: unknown };
      return Array.isArray(body.signInProviders)
        ? PROVIDER_ORDER.filter((provider) => (body.signInProviders as unknown[]).includes(provider))
        : [];
    })
    .catch(() => {
      providersRequest = null;
      return [];
    });
  return providersRequest;
}

function providerButtonLabel(provider: SignInProvider): string {
  return $localize`:Button - sign in or sign up through a third-party account:Continue with ${PROVIDER_NAMES[provider]}:provider:`;
}

/**
 * "Continue with Google / Microsoft / GitHub". Hosted deployments only: the API lists no providers
 * when self-hosted, and the component then renders nothing.
 */
@Component({
  selector: "k-provider-sign-in",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (providers().length) {
      <div class="providers">
        @for (provider of providers(); track provider) {
          <button type="button" class="provider-btn" [disabled]="busy() !== null" (click)="begin(provider)">
            @if (busy() === provider) {
              <i aria-hidden="true" class="ti ti-loader-2 kanera-spin"></i>
            } @else {
              <i aria-hidden="true" [class]="'ti ' + icons[provider]"></i>
            }
            <span>{{ label(provider) }}</span>
          </button>
        }
      </div>
      @if (error()) {
        <p class="provider-error" role="alert"><i aria-hidden="true" class="ti ti-alert-circle"></i> {{ error() }}</p>
      }
      <div class="divider" aria-hidden="true"><span i18n="Separator between third-party sign-in buttons and the email form">or</span></div>
    }
  `,
  styles: [`
    :host { display: block; }
    .providers { display: flex; flex-direction: column; gap: 8px; }
    /* The icon sits at a fixed inset and the label centres across the whole button, so the three
       brand marks line up in one column whatever the label length. */
    button.provider-btn {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      padding-inline: 44px;
      height: var(--h-lg);
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
      font-weight: 500;
    }
    button.provider-btn:hover:not(:disabled) { background: var(--surface-hover); color: var(--text); }
    /* Centred with a margin rather than a transform, which the loading spinner's rotation would replace. */
    button.provider-btn i { position: absolute; left: 16px; top: 50%; margin-top: -0.5em; font-size: 17px; line-height: 1; }
    @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
      button.provider-btn { height: 44px; }
    }
    .provider-error {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 10px 0 0;
      color: var(--danger);
      font-size: var(--text-sm);
    }
    .divider {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 18px 0;
      color: var(--text-muted);
      font-size: var(--text-sm);
    }
    .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: var(--divider); }
  `],
})
export class ProviderSignInComponent implements OnInit {
  private readonly publicAuth = inject(PublicAuthClient);
  private readonly consent = inject(CookieConsentService);
  private readonly analytics = inject(AnalyticsService);
  private readonly destroyRef = inject(DestroyRef);

  /** Where to land after signing in, e.g. an invite page waiting for an accept click. */
  readonly returnUrl = input<string | null>(null);
  readonly inviteToken = input<string | null>(null);
  readonly boardInviteToken = input<string | null>(null);
  /** Which auth page hosts the buttons, so PostHog can tell signup clicks from sign-in clicks. */
  readonly authPage = input.required<ProviderAuthPage>();

  protected readonly providers = signal<SignInProvider[]>([]);
  protected readonly busy = signal<SignInProvider | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly icons = PROVIDER_ICONS;
  protected readonly label = providerButtonLabel;

  async ngOnInit() {
    // Going Back from the provider restores this page from the back/forward cache exactly as it was
    // left, spinner included, without re-running anything. Reset the buttons when that happens.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) this.busy.set(null);
    };
    window.addEventListener("pageshow", onPageShow);
    this.destroyRef.onDestroy(() => window.removeEventListener("pageshow", onPageShow));
    this.providers.set(await loadSignInProviders(this.publicAuth));
  }

  protected async begin(provider: SignInProvider) {
    this.busy.set(provider);
    this.error.set(null);
    // Recorded before leaving for the provider: the redirect unloads the page, and a person who
    // abandons at the provider's consent screen never comes back to report it.
    this.analytics.track("sign_in_provider_selected", { provider, auth_page: this.authPage(), event_version: 1 });
    const returnUrl = this.returnUrl();
    try {
      const res = await this.publicAuth.post(`/auth/providers/${provider}/begin`, {
        ...(returnUrl?.startsWith("/") && !returnUrl.startsWith("//") ? { returnUrl } : {}),
        ...(this.inviteToken() ? { inviteToken: this.inviteToken() } : {}),
        ...(this.boardInviteToken() ? { boardInviteToken: this.boardInviteToken() } : {}),
        locale: appLocale(),
        // Same consent rule as the email signup form: acquisition only with analytics consent.
        ...(this.consent.analyticsAllowed() ? { analyticsAttribution: signupAcquisition() } : {}),
      });
      if (!res.ok) throw new Error("begin failed");
      const { authorizeUrl } = await res.json() as { authorizeUrl: string };
      window.location.assign(authorizeUrl);
    } catch {
      this.busy.set(null);
      this.error.set($localize`Couldn't reach ${PROVIDER_NAMES[provider]}:provider:. Try again.`);
    }
  }
}
