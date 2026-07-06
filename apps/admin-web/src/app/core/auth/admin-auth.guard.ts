import { inject } from "@angular/core";
import { type CanActivateFn, Router } from "@angular/router";
import { AdminAuthService } from "./admin-auth.service";

// Gates the authenticated shell. Attempts a silent refresh (via the httpOnly cookie) before bouncing to
// login, so a page reload with a live session does not force re-authentication.
export const adminAuthGuard: CanActivateFn = async () => {
  const auth = inject(AdminAuthService);
  const router = inject(Router);
  await auth.hydrate();
  if (auth.isAuthenticated()) return true;
  return router.createUrlTree(["/login"]);
};
