import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService, type AuthUser } from "./auth.service";

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

function fetchCallsFor(fetch: { mock: { calls: [RequestInfo | URL, RequestInit?][] } }, path: string) {
  return fetch.mock.calls.filter(([input]) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
    return url.includes(path);
  });
}

// These tests replace process-wide fetch and timer globals. Keep the suite sequential so CI
// workers cannot let one hydration retry loop consume another test's mocked responses.
describe("AuthService logout refresh guard", { concurrent: false }, () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not refresh after logout disables refresh", async () => {
    const auth = new AuthService();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    auth.clearSession({ disableRefresh: true });

    await expect(auth.refresh()).resolves.toBeNull();
    expect(fetchCallsFor(fetch, "/auth/refresh")).toHaveLength(0);
  });

  it("keeps the session and resolves null when refresh fetch fails", async () => {
    const auth = new AuthService();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    auth.setSession("old-token", user());

    await expect(auth.refresh()).resolves.toBeNull();
    expect(auth.user()?.id).toBe("user-1");
    expect(auth.getAccessToken()).toBe("old-token");
  });

  it("clears the session when refresh is rejected by the server", async () => {
    const auth = new AuthService();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));

    auth.setSession("old-token", user());

    await expect(auth.refresh()).resolves.toBeNull();
    expect(auth.user()).toBeNull();
    expect(auth.getAccessToken()).toBeNull();
  });

  it("does not restore a user when an in-flight refresh resolves after logout", async () => {
    const auth = new AuthService();
    const response = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);

    const refresh = auth.refresh();
    auth.clearSession({ disableRefresh: true });
    response.resolve(new Response(JSON.stringify({ accessToken: "new-token", user: user() }), { status: 200 }));

    await expect(refresh).resolves.toBeNull();
    expect(auth.user()).toBeNull();
  });

  it("retries session hydration while the API is restarting", async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: "new-token", user: user() }), { status: 200 }));

    const auth = new AuthService();
    const hydration = auth.hydrate();
    await vi.advanceTimersByTimeAsync(250);
    await hydration;

    expect(fetchCallsFor(fetch, "/auth/refresh")).toHaveLength(2);
    expect(auth.user()?.id).toBe("user-1");
    expect(auth.getAccessToken()).toBe("new-token");
  });

  it("does not retry hydration when the refresh cookie is rejected", async () => {
    vi.useFakeTimers();
    const auth = new AuthService();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));

    await auth.hydrate();
    await vi.runAllTimersAsync();

    expect(fetchCallsFor(fetch, "/auth/refresh")).toHaveLength(1);
  });
});
