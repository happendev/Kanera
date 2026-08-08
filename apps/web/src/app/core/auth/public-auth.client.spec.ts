import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicAuthClient } from "./public-auth.client";

describe("PublicAuthClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends credentialed JSON requests through the public auth boundary", async () => {
    const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      () => Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal("fetch", fetch);

    await TestBed.inject(PublicAuthClient).post("/auth/login", { email: "user@example.com" });

    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(url instanceof Request ? url.url : url).pathname).toBe("/auth/login");
    expect(init).toEqual({
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" }),
    });
  });
});
