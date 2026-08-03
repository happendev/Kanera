import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../auth/auth.service";
import { SocketService } from "../realtime/socket.service";
import { ApiClient, ORGANISATION_SWITCH_NAVIGATOR } from "./api.client";

describe("ApiClient organisation recovery", () => {
  const auth = {
    getAccessToken: vi.fn(() => "client-1-token"),
    refresh: vi.fn(),
    switchOrg: vi.fn(async () => ({ clientId: "client-2" })),
  };
  const sockets = {
    displayedOnline: vi.fn(() => true),
    pauseForOrganisationSwitch: vi.fn(),
    resumeAfterOrganisationSwitch: vi.fn(),
  };
  const reloadAfterOrganisationSwitch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    auth.getAccessToken
      .mockReturnValueOnce("client-1-token")
      .mockReturnValue("client-2-token");
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ApiClient,
        { provide: AuthService, useValue: auth },
        { provide: SocketService, useValue: sockets },
        { provide: ORGANISATION_SWITCH_NAVIGATOR, useValue: reloadAfterOrganisationSwitch },
      ],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("switches to the resource organisation and retries a WRONG_ORG response once", async () => {
    const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: "WRONG_ORG",
        clientId: "client-2",
        orgName: "Second Org",
      }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "workspace-2" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(TestBed.inject(ApiClient).get<{ id: string }>("/workspaces/workspace-2"))
      .resolves.toEqual({ id: "workspace-2" });

    expect(auth.switchOrg).toHaveBeenCalledWith("client-2");
    expect(sockets.pauseForOrganisationSwitch).toHaveBeenCalledTimes(1);
    expect(sockets.resumeAfterOrganisationSwitch).toHaveBeenCalledTimes(1);
    expect(reloadAfterOrganisationSwitch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).get("Authorization")).toBe("Bearer client-1-token");
    expect(new Headers(fetch.mock.calls[1]![1]!.headers).get("Authorization")).toBe("Bearer client-2-token");
  });
});
