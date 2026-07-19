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
        analytics.identify({ userId: user.id });
        analytics.setOrganization({ organizationId: user.clientId, properties: { deployment_mode: "cloud" } });
      };
      // Authentication is the source of truth for analytics identity. This single effect covers login,
      // refresh restoration, logout, account switches, and both sides of a support session.
      effect(syncIdentity);
      return fetch(`${environment.apiUrl}/auth/config`, { credentials: "include" })
        .then(async (response) => response.ok ? await response.json() as { analytics?: AnalyticsRuntimeConfig | null } : null)
        .then((config) => {
          analytics.initialize(config?.analytics ?? null);
          syncIdentity();
        })
        .catch(() => analytics.initialize(null));
    }),
    // Install the global signed-media error-recovery listener once at bootstrap.
    provideAppInitializer(() => { inject(SignedMediaRecoveryService).init(); }),
  ],
};
