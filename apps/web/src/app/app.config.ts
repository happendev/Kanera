import type { ApplicationConfig} from "@angular/core";
import { effect, inject, isDevMode, provideAppInitializer, provideZonelessChangeDetection } from "@angular/core";
import { provideRouter, TitleStrategy, withComponentInputBinding } from "@angular/router";
import { provideServiceWorker } from "@angular/service-worker";
import { environment } from "../environments/environment";
import { routes } from "./app.routes";
import { SignedMediaRecoveryService } from "./core/media/signed-media-recovery.service";
import { AppTitleStrategy } from "./core/title/app-title.service";
import { UpdatesService } from "./core/updates/updates.service";
import { AnalyticsService } from "./core/analytics/analytics.service";
import type { AnalyticsRuntimeConfig } from "./core/analytics/analytics.types";
import { AuthService } from "./core/auth/auth.service";
import { CookieConsentService } from "./core/consent/cookie-consent.service";

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding()),
    { provide: TitleStrategy, useClass: AppTitleStrategy },
    provideServiceWorker("push-worker.js", {
      enabled: environment.production || !isDevMode(),
      registrationStrategy: "registerWhenStable:5000",
    }),
    provideAppInitializer(() => { inject(UpdatesService); }),
    provideAppInitializer(() => {
      const analytics = inject(AnalyticsService);
      const auth = inject(AuthService);
      const consent = inject(CookieConsentService);
      const syncIdentity = () => {
        analytics.ready();
        const user = auth.user();
        const suppressed = auth.isSupportSession() || user?.analyticsExcluded === true;
        analytics.setSuppressed(suppressed);
        if (!user || suppressed) {
          analytics.reset();
          return;
        }
        analytics.identify({ userId: user.id, name: user.displayName, email: user.email });
        analytics.setOrganization({
          organizationId: user.clientId,
          properties: {
            deployment_mode: "cloud",
            name: user.orgName,
            // Owner details live only on the durable organisation profile, never on product events.
            // An owner session enriches the shared profile so members' events remain account-readable.
            ...(user.role === "owner" ? {
              owner_name: user.displayName,
              owner_email: user.email,
              owner_user_id: user.id,
            } : {}),
          },
        });
      };
      // Authentication is the source of truth for analytics identity. This single effect covers login,
      // refresh restoration, logout, account switches, and both sides of a support session.
      effect(syncIdentity);
      // The shared .kanera.app choice is the source of truth for optional browser storage. Keeping
      // this effect ahead of runtime configuration also covers a user changing consent mid-session.
      effect(() => {
        // Wait until the runtime config proves this is the hosted production app. Otherwise the
        // initial "unavailable" state could erase consented cross-subdomain acquisition state.
        if (consent.available()) analytics.setConsent(consent.analyticsAllowed());
      });
      return fetch(`${environment.apiUrl}/auth/config`, { credentials: "include" })
        .then(async (response) => response.ok ? await response.json() as { analytics?: AnalyticsRuntimeConfig | null; deploymentMode?: "self_hosted" | "hosted" } : null)
        .then((config) => {
          // configure returns false for self-hosted, local, and non-production clients, so those
          // deployments neither initialise analytics nor display a redundant consent banner.
          const available = analytics.configure(config?.analytics ?? null, config?.deploymentMode);
          consent.configure(available);
          syncIdentity();
        })
        .catch(() => consent.configure(analytics.configure(null, undefined)));
    }),
    // Install the global signed-media error-recovery listener once at bootstrap.
    provideAppInitializer(() => { inject(SignedMediaRecoveryService).init(); }),
  ],
};
