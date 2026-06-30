import type { ApplicationConfig} from "@angular/core";
import { inject, isDevMode, provideAppInitializer, provideZonelessChangeDetection } from "@angular/core";
import { provideRouter, TitleStrategy, withComponentInputBinding } from "@angular/router";
import { provideServiceWorker } from "@angular/service-worker";
import { environment } from "../environments/environment";
import { routes } from "./app.routes";
import { SignedMediaRecoveryService } from "./core/media/signed-media-recovery.service";
import { AppTitleStrategy } from "./core/title/app-title.service";
import { UpdatesService } from "./core/updates/updates.service";

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
    // Install the global signed-media error-recovery listener once at bootstrap.
    provideAppInitializer(() => { inject(SignedMediaRecoveryService).init(); }),
  ],
};
