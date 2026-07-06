import { Injectable, inject } from "@angular/core";
import { Router } from "@angular/router";
import { ADMIN_LOGOUT_SYNC_KEY, AdminAuthService } from "./admin-auth.service";

// localStorage events fire in the other tabs on the same origin. Keep this listener root-scoped so
// an explicit logout or server-rejected refresh closes every admin tab without touching tenant auth.
@Injectable({ providedIn: "root" })
export class AdminAuthSyncService {
  private readonly auth = inject(AdminAuthService);
  private readonly router = inject(Router);

  constructor() {
    if (typeof window === "undefined") return;
    window.addEventListener("storage", (event) => {
      if (event.key !== ADMIN_LOGOUT_SYNC_KEY || event.newValue === null) return;
      this.auth.clearSession(true);
      void this.router.navigateByUrl("/login");
    });
  }
}
