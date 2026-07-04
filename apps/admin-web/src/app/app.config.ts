import type { ApplicationConfig } from "@angular/core";
import { provideZonelessChangeDetection } from "@angular/core";
import { provideRouter, withComponentInputBinding } from "@angular/router";
import { routes } from "./app.routes";

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    // withComponentInputBinding so route params (:clientId, :userId) bind to input() signals.
    provideRouter(routes, withComponentInputBinding()),
  ],
};
