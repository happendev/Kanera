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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not refresh after logout disables refresh", async () => {
    const auth = new TestAuthService();
    const fetch = auth.fetchMock.mockResolvedValue(new Response("{}"));

    auth.clearSession({ disableRefresh: true });

    await expect(auth.refresh()).resolves.toBeNull();
    expect(fetchCallsFor(fetch, "/auth/refresh")).toHaveLength(0);
  });

  it("keeps the session and resolves null when refresh fetch fails", async () => {
    const auth = new TestAuthService();
    auth.fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    auth.setSession("old-token", user());

    await expect(auth.refresh()).resolves.toBeNull();
    expect(auth.user()?.id).toBe("user-1");
    expect(auth.getAccessToken()).toBe("old-token");
  });

  it("clears the session when refresh is rejected by the server", async () => {
    const auth = new TestAuthService();
    auth.fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));

    auth.setSession("old-token", user());

    await expect(auth.refresh()).resolves.toBeNull();
    expect(auth.user()).toBeNull();
    expect(auth.getAccessToken()).toBeNull();
  });

  it("does not restore a user when an in-flight refresh resolves after logout", async () => {
    const auth = new TestAuthService();
    const response = deferred<Response>();
    auth.fetchMock.mockReturnValue(response.promise);

    const refresh = auth.refresh();
    auth.clearSession({ disableRefresh: true });
    response.resolve(new Response(JSON.stringify({ accessToken: "new-token", user: user() }), { status: 200 }));

    await expect(refresh).resolves.toBeNull();
    expect(auth.user()).toBeNull();
  });

  it("retries session hydration while the API is restarting", async () => {
    vi.useFakeTimers();
    const auth = new TestAuthService();
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
    const auth = new TestAuthService();
    const fetch = auth.fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));

    await auth.hydrate();
    await vi.runAllTimersAsync();

    expect(fetchCallsFor(fetch, "/auth/refresh")).toHaveLength(1);
  });

  it("installs the replacement session returned by an organisation switch", async () => {
    const auth = new TestAuthService();
    auth.setSession("old-token", user({ clientId: "client-1", activeClientId: "client-1" }));
    auth.fetchMock.mockResolvedValue(new Response(JSON.stringify({
      accessToken: "client-2-token",
      user: user({ clientId: "client-2", activeClientId: "client-2", orgName: "Second Org" }),
    }), { status: 200 }));

    await expect(auth.switchOrg("client-2")).resolves.toMatchObject({ clientId: "client-2" });
    expect(auth.getAccessToken()).toBe("client-2-token");
    expect(auth.user()?.orgName).toBe("Second Org");
    const [, init] = fetchCallsFor(auth.fetchMock, "/auth/switch-org")[0]!;
    expect(init?.body).toBe(JSON.stringify({ clientId: "client-2" }));
  });

  it("refreshes the organisation visible in this tab instead of silently following another tab", async () => {
    const auth = new TestAuthService();
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
