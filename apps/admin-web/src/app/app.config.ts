import type { ApplicationConfig } from "@angular/core";
import { inject, isDevMode, provideAppInitializer, provideZonelessChangeDetection } from "@angular/core";
import { provideRouter, withComponentInputBinding } from "@angular/router";
import { provideServiceWorker } from "@angular/service-worker";
import { environment } from "../environments/environment";
import { routes } from "./app.routes";
import { UpdatesService } from "./core/updates/updates.service";

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    // withComponentInputBinding so route params (:clientId, :userId) bind to input() signals.
    provideRouter(routes, withComponentInputBinding()),
    provideServiceWorker("ngsw-worker.js", {
      enabled: environment.production || !isDevMode(),
      registrationStrategy: "registerWhenStable:5000",
    }),
    provideAppInitializer(() => { inject(UpdatesService); }),
  ],
};
