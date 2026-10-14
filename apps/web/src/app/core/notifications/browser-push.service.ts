import { DestroyRef, Injectable, computed, inject, signal } from "@angular/core";
import { icu } from "../i18n/icu";
import type { PushNotificationsConfigResponse, PushSubscriptionBody, PushTestResponse } from "@kanera/shared/dto";
import { environment } from "../../../environments/environment";
import { ApiClient, ApiError } from "../api/api.client";
import { APP_DOM_EVENTS } from "../browser/browser-contracts";

const SERVICE_WORKER_WAIT_MS = 7_000; // 7 seconds

const UNAVAILABLE = $localize`:Browser notification permission or push status - not available here:Unavailable`;

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
        return $localize`:Browser notification permission state:Allowed`;
      case "denied":
        return $localize`:Browser notification permission state:Blocked`;
      case "default":
        return $localize`:Browser notification permission state:Not asked yet`;
      default:
        return UNAVAILABLE;
    }
  });
  readonly statusBadge = computed(() => {
    if (this.subscribed()) return $localize`:Push notification status badge:Subscribed`;
    if (this.configured() && this.unsupportedReason() === null && this.permission() === "granted") return $localize`:Push notification status badge:Ready to subscribe`;
    if (this.configured() && this.unsupportedReason() === null && this.permission() === "default") return $localize`:Push notification status badge:Permission needed`;
    return UNAVAILABLE;
  });
  readonly statusTone = computed<"success" | "warning" | "neutral">(() => {
    if (this.subscribed()) return "success";
    if (!this.configured() || this.unsupportedReason() !== null || this.permission() === "denied") return "warning";
    return "neutral";
  });
  readonly statusMessage = computed(() => {
    if (this.loading()) return $localize`:Push notification status:Checking whether this browser can receive push notifications.`;
    if (this.busy()) return $localize`:Push notification status:Updating this browser's push subscription.`;
    if (!this.configured()) return $localize`:Push notification status:Push notifications are not configured for this Kanera deployment yet.`;
    if (this.unsupportedReason()) return this.unsupportedReason()!;
    if (this.permission() === "denied") return $localize`:Push notification status:Browser notifications are blocked for this site. Re-enable them in your browser settings.`;
    if (this.subscribed()) return $localize`:Push notification status:This browser is subscribed and ready to receive push notifications.`;
    if (this.permission() === "granted") return $localize`:Push notification status:Notifications are allowed in this browser. Turn on push to subscribe this device.`;
    return $localize`:Push notification status:Turn on push notifications to let this browser ask for permission.`;
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
      // Browser registration is identity-wide; `enabled` remains the active organisation's
      // delivery policy and must not hide an already configured deployment VAPID key.
      this.configured.set(config.registrationEnabled && Boolean(config.publicKey));
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
      // Browser state is not proof that the durable server row survived a failed rotation or restore.
      // Re-upsert on authenticated startup so subscription delivery self-heals without a settings visit.
      if (subscription) {
        await this.api.put<void>("/notifications/push/subscription", this.toApiSubscription(subscription));
      }
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
      if (!this.configured()) this.error.set($localize`:Push notification error:Push is not configured for this deployment.`);
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
        this.error.set(permission === "denied"
          ? $localize`:Push notification error:Browser notifications were blocked for this site.`
          : $localize`:Push notification error:Notification permission was not granted.`);
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
      this.testError.set($localize`:Push notification test error:Subscribe this device before sending a test notification.`);
      return;
    }

    this.busy.set(true);
    try {
      const result = await this.api.post<PushTestResponse>("/notifications/push/test", {});
      this.lastResult.set(result);
      if (result.attempted === 0) {
        this.testError.set($localize`:Push notification test error:No active push subscriptions were found for this account.`);
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
      return $localize`:Push notification unsupported reason:Browser push is unavailable in this environment.`;
    }
    if (!window.isSecureContext && !isLocalHostname(window.location.hostname)) {
      return $localize`:Push notification unsupported reason:Push requires HTTPS or localhost.`;
    }
    if (!("serviceWorker" in navigator)) {
      return $localize`:Push notification unsupported reason:This browser does not support service workers.`;
    }
    if (typeof Notification === "undefined") {
      return $localize`:Push notification unsupported reason:This browser does not expose the Notifications API.`;
    }
    if (!("PushManager" in window)) {
      return isAppleMobileBrowser()
        ? $localize`:Push notification unsupported reason:This Safari mode does not expose Web Push. Install Kanera to the home screen first.`
        : $localize`:Push notification unsupported reason:This browser does not expose the Web Push API.`;
    }
    return null;
  }

  private getWorkerPendingMessage(): string {
    return isAppleMobileBrowser()
      ? $localize`:Push notification error:Background notifications are not ready in this browser mode. On iPhone or iPad, install Kanera to the home screen first.`
      : $localize`:Push notification error:Background notifications are still initialising. Try again in a few seconds.`;
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
      throw new Error($localize`:Push notification error:The browser returned an incomplete push subscription.`);
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
  // One message: each clause after "Attempted" only appears when its count is non-zero.
  return icu(
    $localize`:Result of sending a test push notification; counts of devices:Attempted {attempted}{delivered, select, 0 {} other {, delivered {delivered}}}{disabled, plural, =0 {} one {, disabled # stale subscription} other {, disabled # stale subscriptions}}{failed, select, 0 {} other {, failed {failed}}}.`,
    { attempted: result.attempted, delivered: result.delivered, disabled: result.disabled, failed: result.failed },
  );
}

function extractPushError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string } | undefined;
    return body?.message ?? $localize`:Push notification error; status is an HTTP status code:Request failed (${err.status}:status:)`;
  }
  return err instanceof Error ? err.message : $localize`:Push notification error:Something went wrong while updating browser push.`;
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
