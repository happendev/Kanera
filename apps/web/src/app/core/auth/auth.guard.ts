import { inject } from "@angular/core";
import type { CanActivateFn } from "@angular/router";
import { Router } from "@angular/router";
import { AuthService } from "./auth.service";

// Protects authenticated app routes. Hydration lets a valid refresh cookie restore
// the in-memory session before deciding whether to send the user to login.
export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.hydrate();
  if (auth.isAuthenticated()) return true;
  return router.createUrlTree(["/login"]);
};

// Keeps logged-in users out of public auth screens like login and signup.
// The root route then applies the normal workspace/onboarding routing rules.
export const publicAuthGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.hydrate();
  if (!auth.isAuthenticated()) return true;
  return router.createUrlTree(["/"]);
};

// Reset links must include a token; otherwise send the user back to the
// request-reset page instead of showing a form that cannot succeed.
export const resetPasswordGuard: CanActivateFn = (route) => {
  const router = inject(Router);
  const token = route.queryParamMap.get("token")?.trim();
  if (token) return true;
  return router.createUrlTree(["/forgot-password"]);
};
