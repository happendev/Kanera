import { describe, expect, it, vi } from "vitest";
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

describe("AuthService logout refresh guard", () => {
  it("does not refresh after logout disables refresh", async () => {
    const auth = new AuthService();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    auth.clearSession({ disableRefresh: true });

    await expect(auth.refresh()).resolves.toBeNull();
    expect(fetchCallsFor(fetch, "/auth/refresh")).toHaveLength(0);

    fetch.mockRestore();
  });

  it("keeps the session and resolves null when refresh fetch fails", async () => {
    const auth = new AuthService();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    auth.setSession("old-token", user());

    await expect(auth.refresh()).resolves.toBeNull();
    expect(auth.user()?.id).toBe("user-1");
    expect(auth.getAccessToken()).toBe("old-token");

    fetch.mockRestore();
  });

  it("clears the session when refresh is rejected by the server", async () => {
    const auth = new AuthService();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));

    auth.setSession("old-token", user());

    await expect(auth.refresh()).resolves.toBeNull();
    expect(auth.user()).toBeNull();
    expect(auth.getAccessToken()).toBeNull();

    fetch.mockRestore();
  });

  it("does not restore a user when an in-flight refresh resolves after logout", async () => {
    const auth = new AuthService();
    const response = deferred<Response>();
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);

    const refresh = auth.refresh();
    auth.clearSession({ disableRefresh: true });
    response.resolve(new Response(JSON.stringify({ accessToken: "new-token", user: user() }), { status: 200 }));

    await expect(refresh).resolves.toBeNull();
    expect(auth.user()).toBeNull();

    fetch.mockRestore();
  });
});
