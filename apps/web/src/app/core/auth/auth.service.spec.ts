import { Injector, runInInjectionContext } from "@angular/core";
import { SessionCleanupService } from "./session-cleanup.service";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService, authenticatedLandingPath, type AuthUser } from "./auth.service";

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "user-1",
    clientId: "client-1",
    email: "me@example.com",
    displayName: "Me User",
    avatarUrl: null,
    orgName: "Kanera",
    logoUrl: null,
    deploymentMode: "hosted",
    hasWorkspace: true,
    role: "member",
    timezone: "UTC",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class TestAuthService extends AuthService {
  readonly fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

  protected override request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.fetchMock(input, init);
  }
}

function createAuth(): TestAuthService {
  const injector = Injector.create({ providers: [{ provide: SessionCleanupService, useValue: {
    clear: () => Promise.resolve(), ready: () => Promise.resolve(),
  } }] });
  return runInInjectionContext(injector, () => new TestAuthService());
}

function fetchCallsFor(fetch: { mock: { calls: [RequestInfo | URL, RequestInit?][] } }, path: string) {
  return fetch.mock.calls.filter(([input]) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
    return url.includes(path);
  });
}

describe("authenticatedLandingPath", () => {
  it("sends grant-less members to the actionable home empty state", () => {
    expect(authenticatedLandingPath(user({ hasWorkspace: false, role: "member" }))).toBe("/");
  });

  it("sends organisation admins through the shell guard when hasWorkspace is false", () => {
    // hasWorkspace excludes standalone boards, so the shell guard must inspect home content before
    // deciding whether this is a genuinely empty organisation that needs onboarding.
    expect(authenticatedLandingPath(user({ hasWorkspace: false, role: "admin" }))).toBe("/");
    expect(authenticatedLandingPath(user({ hasWorkspace: false, role: "owner" }))).toBe("/");
  });
});

// Fake timers are process-wide. Keep the suite sequential so one hydration retry loop cannot
// advance another test's clock.
describe("AuthService logout refresh guard", { concurrent: false }, () => {
  afterEach(() => {
    localStorage.removeItem("kanera:offline-identity");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not refresh after logout disables refresh", async () => {
    const auth = createAuth();
    const fetch = auth.fetchMock.mockResolvedValue(new Response("{}"));

    void auth.clearSession({ disableRefresh: true });

    await expect(auth.refresh()).resolves.toBeNull();
    expect(fetchCallsFor(fetch, "/auth/refresh")).toHaveLength(0);
  });

  it("keeps the session and resolves null when refresh fetch fails", async () => {
    const auth = createAuth();
    auth.fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    auth.setSession("old-token", user());

    await expect(auth.refresh()).resolves.toBeNull();
    expect(auth.user()?.id).toBe("user-1");
    expect(auth.getAccessToken()).toBe("old-token");
  });

  it("clears the session when refresh is rejected by the server", async () => {
    const auth = createAuth();
    auth.fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));

    auth.setSession("old-token", user());

    await expect(auth.refresh()).resolves.toBeNull();
    expect(auth.user()).toBeNull();
    expect(auth.getAccessToken()).toBeNull();
  });

  it("does not restore a user when an in-flight refresh resolves after logout", async () => {
    const auth = createAuth();
    const response = deferred<Response>();
    auth.fetchMock.mockReturnValue(response.promise);

    const refresh = auth.refresh();
    void auth.clearSession({ disableRefresh: true });
    response.resolve(new Response(JSON.stringify({ accessToken: "new-token", user: user() }), { status: 200 }));

    await expect(refresh).resolves.toBeNull();
    expect(auth.user()).toBeNull();
  });

  it("retries session hydration while the API is restarting", async () => {
    vi.useFakeTimers();
    const auth = createAuth();
    const fetch = auth.fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: "new-token", user: user() }), { status: 200 }));

    const hydration = auth.hydrate();
    await vi.advanceTimersByTimeAsync(250);
    await hydration;

    expect(fetchCallsFor(fetch, "/auth/refresh")).toHaveLength(2);
    expect(auth.user()?.id).toBe("user-1");
    expect(auth.getAccessToken()).toBe("new-token");
  });

  it("does not retry hydration when the refresh cookie is rejected", async () => {
    vi.useFakeTimers();
    const auth = createAuth();
    const fetch = auth.fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));

    await auth.hydrate();
    await vi.runAllTimersAsync();

    expect(fetchCallsFor(fetch, "/auth/refresh")).toHaveLength(1);
  });

  it("installs the replacement session returned by an organisation switch", async () => {
    const auth = createAuth();
    auth.setSession("old-token", user({ clientId: "client-1", activeClientId: "client-1" }));
    auth.fetchMock.mockResolvedValue(new Response(JSON.stringify({
      accessToken: "client-2-token",
      user: user({ clientId: "client-2", activeClientId: "client-2", orgName: "Second Org" }),
    }), { status: 200 }));

    await expect(auth.switchOrg("client-2")).resolves.toMatchObject({ clientId: "client-2" });
    expect(auth.getAccessToken()).toBe("client-2-token");
    expect(auth.user()?.orgName).toBe("Second Org");
    expect(auth.organisationSwitchPending()).toBe(true);
    const [, init] = fetchCallsFor(auth.fetchMock, "/auth/switch-org")[0]!;
    expect(init?.body).toBe(JSON.stringify({ clientId: "client-2" }));
  });

  it("allows another organisation-switch attempt after a rejected switch", async () => {
    const auth = createAuth();
    auth.setSession("token", user());
    auth.fetchMock.mockResolvedValue(new Response("{}", { status: 403 }));

    await expect(auth.switchOrg("client-2")).rejects.toThrow("organisation switch failed (403)");

    expect(auth.organisationSwitchPending()).toBe(false);
  });

  it("refreshes an expired access token and retries an organisation switch", async () => {
    const auth = createAuth();
    auth.setSession("expired-token", user({ clientId: "client-1", activeClientId: "client-1" }));
    let switchAttempt = 0;
    auth.fetchMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      if (url.includes("/auth/refresh")) return new Response(JSON.stringify({
        accessToken: "refreshed-token",
        user: user({ clientId: "client-1", activeClientId: "client-1" }),
      }), { status: 200 });
      if (url.includes("/auth/switch-org")) {
        switchAttempt += 1;
        return switchAttempt === 1
          ? new Response("{}", { status: 401 })
          : new Response(JSON.stringify({
            accessToken: "client-2-token",
            user: user({ clientId: "client-2", activeClientId: "client-2", orgName: "Second Org" }),
          }), { status: 200 });
      }
      return new Response("{}", { status: 500 });
    });

    await expect(auth.switchOrg("client-2")).resolves.toMatchObject({ clientId: "client-2" });

    const switchCalls = fetchCallsFor(auth.fetchMock, "/auth/switch-org");
    expect(switchCalls).toHaveLength(2);
    expect(new Headers(switchCalls[0]![1]?.headers).get("Authorization")).toBe("Bearer expired-token");
    expect(new Headers(switchCalls[1]![1]?.headers).get("Authorization")).toBe("Bearer refreshed-token");
    expect(fetchCallsFor(auth.fetchMock, "/auth/refresh")).toHaveLength(1);
    expect(auth.getAccessToken()).toBe("client-2-token");
  });

  it("refreshes the organisation visible in this tab instead of silently following another tab", async () => {
    const auth = createAuth();
    auth.setSession("client-2-old", user({ clientId: "client-2", activeClientId: "client-2" }));
    auth.fetchMock.mockResolvedValue(new Response(JSON.stringify({
      accessToken: "client-2-new",
      user: user({ clientId: "client-2", activeClientId: "client-2" }),
    }), { status: 200 }));

    await expect(auth.refresh()).resolves.toBe("client-2-new");
    expect(auth.user()?.clientId).toBe("client-2");
    const [, init] = fetchCallsFor(auth.fetchMock, "/auth/refresh")[0]!;
    expect(init?.body).toBe(JSON.stringify({ clientId: "client-2" }));
  });
});

describe("offline session recovery", () => {
  afterEach(() => {
    localStorage.removeItem("kanera:offline-identity");
    vi.restoreAllMocks();
  });

  it("restores a bounded identity without persisting or granting a bearer token", async () => {
    const first = createAuth();
    first.setSession("secret-token", user());
    expect(localStorage.getItem("kanera:offline-identity")).not.toContain("secret-token");
    const restored = createAuth();
    restored.fetchMock.mockRejectedValue(new TypeError("offline"));
    await restored.hydrate();
    expect(restored.user()?.id).toBe("user-1");
    expect(restored.offlineSession()).toBe(true);
    expect(restored.getAccessToken()).toBeNull();
    restored.fetchMock.mockResolvedValue(new Response(JSON.stringify({ accessToken: "fresh", user: user() })));
    await restored.refresh();
    expect(restored.offlineSession()).toBe(false);
    expect(restored.getAccessToken()).toBe("fresh");
  });

  it("never restores identity after an explicit cookie rejection", async () => {
    createAuth().setSession("old", user());
    const restored = createAuth();
    restored.fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    await restored.hydrate();
    expect(restored.user()).toBeNull();
    expect(localStorage.getItem("kanera:offline-identity")).toBeNull();
  });

  it("rejects expired offline identities and clears identity on logout", async () => {
    const auth = createAuth();
    auth.setSession("old", user());
    localStorage.setItem("kanera:offline-identity", JSON.stringify({ user: user(), cachedAt: Date.now() - 8 * 86400000 }));
    expect((auth as unknown as { restoreOfflineIdentity(): boolean }).restoreOfflineIdentity()).toBe(false);
    void auth.clearSession({ disableRefresh: true });
    expect(localStorage.getItem("kanera:offline-identity")).toBeNull();
  });
});
