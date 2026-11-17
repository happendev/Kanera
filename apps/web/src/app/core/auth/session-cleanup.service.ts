import { Injectable, inject } from "@angular/core";
import { OfflineCacheService } from "../offline/offline-cache.service";
import { clearSessionStorage, SESSION_CLEANUP_KEY, CLEANUP_PENDING_KEY } from "../browser/session-storage";

@Injectable({ providedIn: "root" })
export class SessionCleanupService {
  private readonly offline = inject(OfflineCacheService);
  private pending: Promise<void> | null = null;
  private beforeSignIn: Promise<unknown> = Promise.resolve();

  clear(options: { preserveIncomingShare?: boolean; beforeSignIn?: Promise<unknown>; retry?: boolean } = {}): Promise<void> {
    if (options.beforeSignIn) this.beforeSignIn = options.beforeSignIn;
    if (this.pending) {
      // Another account can sign in while a browser operation is blocked. Its later logout
      // must still replace the signed-out marker and erase its local preferences immediately.
      if (!options.retry) {
        try {
          localStorage.setItem(SESSION_CLEANUP_KEY, "pending");
          clearSessionStorage();
        } catch { /* The pending cleanup keeps private storage quarantined. */ }
      }
      return this.pending;
    }
    // Start synchronously so route destruction cannot save an outgoing editor's draft again.
    // The outgoing logout response can delete the refresh cookie. In this tab, do not let a new
    // login race that response and then lose its newly issued cookie.
    const work: Promise<unknown>[] = options.beforeSignIn ? [options.beforeSignIn] : [];
    try {
      if (!options.retry) localStorage.setItem(SESSION_CLEANUP_KEY, "pending");
      localStorage.setItem(CLEANUP_PENDING_KEY, "1");
      clearSessionStorage(options.retry);
    } catch (error) { work.push(Promise.reject(new Error("Browser storage cleanup failed", { cause: error }))); }
    work.push(this.offline.clearAll());
    if (!options.preserveIncomingShare && typeof caches !== "undefined") work.push(caches.delete("kanera-share-target-v1"));
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      work.push(navigator.serviceWorker.getRegistration().then(async (registration) => {
        if (!registration) return;
        const subscription = await registration.pushManager?.getSubscription();
        if (subscription) await subscription.unsubscribe();
        const notifications = await registration.getNotifications?.() ?? [];
        for (const notification of notifications) notification.close();
      }));
    }
    this.pending = Promise.allSettled(work).then((results) => {
      if (results.some((result) => result.status === "rejected")) throw new Error("Session cleanup failed");
      localStorage.removeItem(CLEANUP_PENDING_KEY);
      if (localStorage.getItem(SESSION_CLEANUP_KEY)) localStorage.setItem(SESSION_CLEANUP_KEY, "done");
    }).catch(() => {
      // Browser cleanup is our responsibility. Keep private storage quarantined and retry on
      // the next auth request/startup, without asking the person signing in to repair their browser.
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async ready(): Promise<void> {
    // Only cookie revocation gates a new login. Browser storage may be blocked by another tab;
    // quarantine makes it safe to keep that cleanup running without holding up authentication.
    await this.beforeSignIn.catch(() => undefined);
    if (this.pending) return;
    try {
      if (localStorage.getItem(CLEANUP_PENDING_KEY) || localStorage.getItem(SESSION_CLEANUP_KEY) === "pending") {
        void this.clear({ retry: true });
      }
    } catch { /* Storage may be unavailable; online authentication still works. */ }
  }
}
