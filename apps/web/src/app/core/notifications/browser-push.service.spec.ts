import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/api.client";
import { BrowserPushService } from "./browser-push.service";

function createSubscription(endpoint = "https://push.example.test/subscriptions/device-1") {
  return {
    endpoint,
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({
      endpoint,
      expirationTime: null,
      keys: {
        p256dh: "p256dh-value",
        auth: "auth-value",
      },
    }),
  } as unknown as PushSubscription;
}

describe("BrowserPushService", () => {
  let api: {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let service: BrowserPushService;
  let subscription: PushSubscription | null;
  let registration: ServiceWorkerRegistration;
  let notificationApi: { permission: NotificationPermission; requestPermission: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    subscription = null;
    registration = {
      pushManager: {
        getSubscription: vi.fn(async () => subscription),
        subscribe: vi.fn(async () => {
          subscription = createSubscription();
          return subscription;
        }),
      },
    } as unknown as ServiceWorkerRegistration;

    notificationApi = {
      permission: "default",
      requestPermission: vi.fn(async () => {
        notificationApi.permission = "granted";
        return "granted";
      }),
    };

    api = {
      get: vi.fn(async () => ({ enabled: true, publicKey: "BF5R6QtTp0hkR0_FttrW9ng15lSuUebte47AG1eoaD-ZFQxKYe5CvLdj-sZXzs5kD7WJGnQpFakFCrUvgsTy1yw" })),
      put: vi.fn(async () => undefined),
      post: vi.fn(async () => ({ attempted: 1, delivered: 1, disabled: 0, failed: 0 })),
      delete: vi.fn(async () => undefined),
    };

    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    class PushManagerStub { }
    (PushManagerStub as typeof PushManager & { supportedContentEncodings?: string[] }).supportedContentEncodings = ["aes128gcm"];

    vi.stubGlobal("Notification", notificationApi);
    vi.stubGlobal("PushManager", PushManagerStub);
    Object.defineProperty(window, "PushManager", { value: PushManagerStub, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "serviceWorker", {
      value: {
        getRegistration: vi.fn(async () => registration),
        ready: Promise.resolve(registration),
        addEventListener: vi.fn(),
      },
      configurable: true,
    });

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        BrowserPushService,
        { provide: ApiClient, useValue: api },
      ],
    });

    service = TestBed.inject(BrowserPushService);
  });

  it("marks push unavailable when the deployment disables it", async () => {
    api.get.mockResolvedValueOnce({ enabled: false, publicKey: null });

    await service.initialise();

    expect(service.configured()).toBe(false);
    expect(service.statusBadge()).toBe("Unavailable");
    expect(service.statusMessage()).toContain("deployment");
  });

  it("requests permission, subscribes the browser, and persists the subscription", async () => {
    await service.initialise();
    await service.subscribe();

    expect(notificationApi.requestPermission).toHaveBeenCalledTimes(1);
    expect((registration.pushManager.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      userVisibleOnly: true,
    });
    expect(api.put).toHaveBeenCalledWith("/notifications/push/subscription", expect.objectContaining({
      endpoint: "https://push.example.test/subscriptions/device-1",
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
      contentEncoding: "aes128gcm",
    }));
    expect(service.subscriptionEndpoint()).toBe("https://push.example.test/subscriptions/device-1");
  });

  it("sends a test push and reports the delivery summary", async () => {
    notificationApi.permission = "granted";
    subscription = createSubscription();

    await service.initialise();
    await service.sendTest();

    expect(api.post).toHaveBeenCalledWith("/notifications/push/test", {});
    expect(service.testSuccess()).toBe("Attempted 1, delivered 1.");
    expect(service.lastResult()).toEqual({ attempted: 1, delivered: 1, disabled: 0, failed: 0 });
  });
});