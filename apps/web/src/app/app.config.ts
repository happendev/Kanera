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
      const syncIdentity = () => {
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
      return fetch(`${environment.apiUrl}/auth/config`, { credentials: "include" })
        .then(async (response) => response.ok ? await response.json() as { analytics?: AnalyticsRuntimeConfig | null; deploymentMode?: "self_hosted" | "hosted" } : null)
        .then((config) => {
          // deploymentMode is passed through so analytics can only ever initialise in hosted mode.
          analytics.initialize(config?.analytics ?? null, config?.deploymentMode);
          syncIdentity();
        })
        .catch(() => analytics.initialize(null, undefined));
    }),
    // Install the global signed-media error-recovery listener once at bootstrap.
    provideAppInitializer(() => { inject(SignedMediaRecoveryService).init(); }),
  ],
};
