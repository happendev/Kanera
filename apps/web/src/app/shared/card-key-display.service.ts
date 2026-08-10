import { Injectable, computed, inject } from "@angular/core";
import { AuthService } from "../core/auth/auth.service";

@Injectable({ providedIn: "root" })
export class CardKeyDisplayService {
  private readonly auth = inject(AuthService);

  /**
   * Whether card keys render in on-screen chrome. Account-scoped, so unlike
   * CardLabelDisplayService there is no localStorage and no cross-tab "storage" listener —
   * this is a pure view over the session, and setSession/reloadMe/switchOrg are its only
   * writers. Defaults ON so a bundle newer than the API, or a session issued before the
   * migration during a rolling deploy, renders exactly as before.
   *
   * Known limit: a second open tab keeps the old value until its next refresh. A display
   * preference does not justify a realtime event.
   */
  readonly showCardKeys = computed(() => this.auth.user()?.showCardKeys ?? true);
}
