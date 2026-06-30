import { DestroyRef, Injectable, computed, inject, signal } from "@angular/core";
import type { PushNotificationsConfigResponse, PushSubscriptionBody, PushTestResponse } from "@kanera/shared/dto";
import { environment } from "../../../environments/environment";
import { ApiClient, ApiError } from "../api/api.client";
import { APP_DOM_EVENTS } from "../browser/browser-contracts";

const SERVICE_WORKER_WAIT_MS = 7_000; // 7 seconds

@Injectable({ providedIn: "root" })
export class BrowserPushService {
  private readonly api = inject(ApiClient);
  private readonly destroyRef = inject(DestroyRef);
  private vapidPublicKey: string | null = null;
  private workerMessagesAttached = false;

  readonly initialised = signal(false);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly configured = signal(false);
  readonly unsupportedReason = signal<string | null>(null);
  readonly permission = signal<NotificationPermission | "unsupported">("unsupported");
  readonly subscriptionEndpoint = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly testError = signal<string | null>(null);
  readonly testSuccess = signal<string | null>(null);
  readonly lastResult = signal<PushTestResponse | null>(null);

  readonly subscribed = computed(() => this.subscriptionEndpoint() !== null);
  readonly canRefresh = computed(
    () => !this.loading() && !this.busy() && this.configured() && this.unsupportedReason() === null && this.permission() !== "denied",
  );
  readonly canUnsubscribe = computed(() => !this.loading() && !this.busy() && this.subscribed());
  readonly canSendTest = computed(() => !this.loading() && !this.busy() && this.subscribed());
  readonly permissionLabel = computed(() => {
    switch (this.permission()) {
      case "granted":
        return "Allowed";
      case "denied":
        return "Blocked";
      case "default":
        return "Not asked yet";
      default:
        return "Unavailable";
    }
  });
  readonly statusBadge = computed(() => {
    if (this.subscribed()) return "Subscribed";
    if (this.configured() && this.unsupportedReason() === null && this.permission() === "granted") return "Ready to subscribe";
    if (this.configured() && this.unsupportedReason() === null && this.permission() === "default") return "Permission needed";
    return "Unavailable";
  });
  readonly statusTone = computed<"success" | "warning" | "neutral">(() => {
    if (this.subscribed()) return "success";
    if (!this.configured() || this.unsupportedReason() !== null || this.permission() === "denied") return "warning";
    return "neutral";
  });
  readonly statusMessage = computed(() => {
    if (this.loading()) return "Checking whether this browser can receive push notifications.";
    if (this.busy()) return "Updating this browser's push subscription.";
    if (!this.configured()) return "Push notifications are not configured for this Kanera deployment yet.";
    if (this.unsupportedReason()) return this.unsupportedReason()!;
    if (this.permission() === "denied") return "Browser notifications are blocked for this site. Re-enable them in your browser settings.";
    if (this.subscribed()) return "This browser is subscribed and ready to receive push notifications.";
    if (this.permission() === "granted") return "Notifications are allowed in this browser. Turn on push to subscribe this device.";
    return "Turn on push notifications to let this browser ask for permission.";
  });

  constructor() {
    this.watchPermissionChanges();
  }

  async initialise(force = false): Promise<void> {
    if (this.initialised() && !force) return;

    this.loading.set(true);
    this.error.set(null);
    if (!force) {
      this.testError.set(null);
      this.testSuccess.set(null);
      this.lastResult.set(null);
    }

    try {
      const config = await this.api.get<PushNotificationsConfigResponse>("/notifications/push/config");
      this.vapidPublicKey = config.publicKey;
      this.configured.set(config.enabled && Boolean(config.publicKey));
      this.permission.set(this.readPermission());

      const capabilityError = this.getCapabilityError();
      this.unsupportedReason.set(capabilityError);
      if (!this.configured()) {
        this.subscriptionEndpoint.set(null);
        return;
      }
      if (capabilityError) {
        this.subscriptionEndpoint.set(null);
        return;
      }

      this.attachWorkerMessages();
      const registration = await this.getServiceWorkerRegistration();
      if (!registration) {
        this.subscriptionEndpoint.set(null);
        this.unsupportedReason.set(this.getWorkerPendingMessage());
        return;
      }

      const subscription = await registration.pushManager.getSubscription();
      this.subscriptionEndpoint.set(subscription?.endpoint ?? null);
    } catch (err) {
      this.error.set(extractPushError(err));
    } finally {
      this.loading.set(false);
      this.initialised.set(true);
    }
  }

  async subscribe(): Promise<void> {
    this.error.set(null);
    this.testError.set(null);
    this.testSuccess.set(null);

    if (!this.canRefresh()) {
      if (!this.configured()) this.error.set("Push is not configured for this deployment.");
      else if (this.unsupportedReason()) this.error.set(this.unsupportedReason());
      return;
    }

    this.busy.set(true);
    try {
      let permission = this.readPermission();
      if (permission === "default") {
        permission = await Notification.requestPermission();
      }
      this.permission.set(permission);
      if (permission !== "granted") {
        this.error.set(permission === "denied" ? "Browser notifications were blocked for this site." : "Notification permission was not granted.");
        return;
      }

      const registration = await this.getServiceWorkerRegistration();
      if (!registration) {
        this.error.set(this.getWorkerPendingMessage());
        return;
      }

      const subscription = await registration.pushManager.getSubscription()
        ?? await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeBase64Url(this.vapidPublicKey!),
        });

      await this.api.put<void>("/notifications/push/subscription", this.toApiSubscription(subscription));
      this.subscriptionEndpoint.set(subscription.endpoint);
    } catch (err) {
      this.error.set(extractPushError(err));
    } finally {
      this.busy.set(false);
    }
  }

  async unsubscribe(): Promise<void> {
    this.error.set(null);
    this.testError.set(null);
    this.testSuccess.set(null);

    this.busy.set(true);
    try {
      const registration = await this.getServiceWorkerRegistration();
      const subscription = await registration?.pushManager.getSubscription() ?? null;
      const endpoint = subscription?.endpoint ?? this.subscriptionEndpoint();
      if (!endpoint) return;

      try {
        await this.deleteSubscription(endpoint);
      } finally {
        if (subscription) await subscription.unsubscribe().catch(() => undefined);
      }
      this.subscriptionEndpoint.set(null);
    } catch (err) {
      this.error.set(extractPushError(err));
    } finally {
      this.busy.set(false);
    }
  }

  async unsubscribeForLogout(accessToken: string | null): Promise<void> {
    const registration = await this.getExistingServiceWorkerRegistration();
    const subscription = await registration?.pushManager.getSubscription() ?? null;
    const endpoint = subscription?.endpoint ?? this.subscriptionEndpoint();
    if (!endpoint) return;

    try {
      await this.deleteSubscription(endpoint, accessToken);
    } finally {
      if (subscription) await subscription.unsubscribe().catch(() => undefined);
    }
    this.subscriptionEndpoint.set(null);
  }

  async sendTest(): Promise<void> {
    this.error.set(null);
    this.testError.set(null);
    this.testSuccess.set(null);

    if (!this.canSendTest()) {
      this.testError.set("Subscribe this device before sending a test notification.");
      return;
    }

    this.busy.set(true);
    try {
      const result = await this.api.post<PushTestResponse>("/notifications/push/test", {});
      this.lastResult.set(result);
      if (result.attempted === 0) {
        this.testError.set("No active push subscriptions were found for this account.");
      } else if (result.delivered > 0) {
        this.testSuccess.set(describePushResult(result));
      } else {
        this.testError.set(describePushResult(result));
      }
      await this.initialise(true);
    } catch (err) {
      this.testError.set(extractPushError(err));
    } finally {
      this.busy.set(false);
    }
  }

  async syncFromBrowser(): Promise<void> {
    if (!this.configured() || this.getCapabilityError() !== null) return;

    const registration = await this.getServiceWorkerRegistration();
    if (!registration) return;

    const subscription = await registration.pushManager.getSubscription();
    this.permission.set(this.readPermission());
    if (subscription) {
      await this.api.put<void>("/notifications/push/subscription", this.toApiSubscription(subscription));
      this.subscriptionEndpoint.set(subscription.endpoint);
      return;
    }

    const endpoint = this.subscriptionEndpoint();
    if (endpoint) {
      await this.api.delete<void>("/notifications/push/subscription", { endpoint });
      this.subscriptionEndpoint.set(null);
    }
  }

  refreshPermission(): void {
    this.permission.set(this.readPermission());
  }

  private readPermission(): NotificationPermission | "unsupported" {
    if (typeof Notification === "undefined") return "unsupported";
    return Notification.permission;
  }

  private getCapabilityError(): string | null {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
      return "Browser push is unavailable in this environment.";
    }
    if (!window.isSecureContext && !isLocalHostname(window.location.hostname)) {
      return "Push requires HTTPS or localhost.";
    }
    if (!("serviceWorker" in navigator)) {
      return "This browser does not support service workers.";
    }
    if (typeof Notification === "undefined") {
      return "This browser does not expose the Notifications API.";
    }
    if (!("PushManager" in window)) {
      return isAppleMobileBrowser()
        ? "This Safari mode does not expose Web Push. Install Kanera to the home screen first."
        : "This browser does not expose the Web Push API.";
    }
    return null;
  }

  private getWorkerPendingMessage(): string {
    return isAppleMobileBrowser()
      ? "Background notifications are not ready in this browser mode. On iPhone or iPad, install Kanera to the home screen first."
      : "Background notifications are still initialising. Try again in a few seconds.";
  }

  private async getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;

    const existing = await navigator.serviceWorker.getRegistration();
    if (existing) return existing;

    try {
      return await Promise.race([
        navigator.serviceWorker.ready.then((registration) => registration ?? null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SERVICE_WORKER_WAIT_MS)),
      ]);
    } catch {
      return null;
    }
  }

  private async getExistingServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
    try {
      return await navigator.serviceWorker.getRegistration() ?? null;
    } catch {
      return null;
    }
  }

  private async deleteSubscription(endpoint: string, accessToken?: string | null): Promise<void> {
    if (accessToken === undefined) {
      await this.api.delete<void>("/notifications/push/subscription", { endpoint });
      return;
    }

    const headers = new Headers({ "Content-Type": "application/json" });
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

    const response = await fetch(`${environment.apiUrl}/notifications/push/subscription`, {
      method: "DELETE",
      headers,
      credentials: "include",
      body: JSON.stringify({ endpoint }),
    });

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => ({ message: response.statusText }));
      throw new ApiError(response.status, body);
    }
  }

  private attachWorkerMessages(): void {
    if (this.workerMessagesAttached || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const handleMessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === APP_DOM_EVENTS.PUSH_SUBSCRIPTION_CHANGED) {
        void this.syncFromBrowser();
      }
    };

    navigator.serviceWorker.addEventListener("message", handleMessage);
    this.workerMessagesAttached = true;
  }

  private watchPermissionChanges(): void {
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      const refresh = () => this.refreshPermission();
      window.addEventListener("focus", refresh);
      document.addEventListener("visibilitychange", refresh);
      this.destroyRef.onDestroy(() => {
        window.removeEventListener("focus", refresh);
        document.removeEventListener("visibilitychange", refresh);
      });
    }

    if (typeof navigator === "undefined" || !("permissions" in navigator)) return;
    void navigator.permissions
      .query({ name: "notifications" as PermissionName })
      .then((status) => {
        const refresh = () => this.refreshPermission();
        status.addEventListener("change", refresh);
        this.destroyRef.onDestroy(() => status.removeEventListener("change", refresh));
      })
      .catch(() => undefined);
  }

  private toApiSubscription(subscription: PushSubscription): PushSubscriptionBody {
    const json = subscription.toJSON();
    const p256dh = json.keys?.["p256dh"];
    const auth = json.keys?.["auth"];
    if (!json.endpoint || !p256dh || !auth) {
      throw new Error("The browser returned an incomplete push subscription.");
    }

    const contentEncoding = getSupportedContentEncoding();
    return {
      endpoint: json.endpoint,
      expirationTime: json.expirationTime ?? null,
      ...(contentEncoding ? { contentEncoding } : {}),
      ...(typeof navigator !== "undefined" ? { userAgent: navigator.userAgent } : {}),
      keys: {
        p256dh,
        auth,
      },
    };
  }
}

function decodeBase64Url(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4 || 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function describePushResult(result: PushTestResponse): string {
  const parts = [`Attempted ${result.attempted}`];
  if (result.delivered > 0) parts.push(`delivered ${result.delivered}`);
  if (result.disabled > 0) parts.push(`disabled ${result.disabled} stale subscription${result.disabled === 1 ? "" : "s"}`);
  if (result.failed > 0) parts.push(`failed ${result.failed}`);
  return `${parts.join(", ")}.`;
}

function extractPushError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string } | undefined;
    return body?.message ?? `Request failed (${err.status})`;
  }
  return err instanceof Error ? err.message : "Something went wrong while updating browser push.";
}

function getSupportedContentEncoding(): string | undefined {
  if (typeof PushManager === "undefined") return undefined;
  const ctor = PushManager as typeof PushManager & { supportedContentEncodings?: string[] };
  return ctor.supportedContentEncodings?.[0];
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isAppleMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}
