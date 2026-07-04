import { inject } from "@angular/core";
import { type CanActivateFn, Router } from "@angular/router";
import { AdminAuthService } from "./admin-auth.service";

// Optional guard for destructive-only routes. Destructive actions are also enforced server-side
// (superadmin required), so this is defense-in-depth / UX, not the security boundary.
export const superadminGuard: CanActivateFn = () => {
  const auth = inject(AdminAuthService);
  const router = inject(Router);
  if (auth.isSuperadmin()) return true;
  return router.createUrlTree(["/"]);
};
