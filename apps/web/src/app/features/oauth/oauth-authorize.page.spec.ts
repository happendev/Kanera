import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { OauthAuthorizePage } from "./oauth-authorize.page";

describe("OauthAuthorizePage", () => {
  const context = {
    clientName: "Example agent",
    scopes: ["kanera:read", "kanera:write"],
    redirectUri: "https://client.example/oauth/callback",
    redirectOrigin: "https://client.example",
    isLoopbackRedirect: false,
  };
  let get: ReturnType<typeof vi.fn>;
  let post: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    get = vi.fn(async () => context);
    post = vi.fn(async (path: string) => {
      if (path === "/oauth/authorize/deny") {
        return {
          redirectUrl: "https://client.example/oauth/callback?error=access_denied&state=request-state",
          redirectOrigin: "https://client.example",
          isLoopbackRedirect: false,
        };
      }
      return { redirectUrl: "https://client.example/oauth/callback?code=code" };
    });
    await TestBed.configureTestingModule({
      imports: [OauthAuthorizePage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get, post } },
      ],
    }).compileComponents();
  });

  async function render() {
    const fixture = TestBed.createComponent(OauthAuthorizePage);
    fixture.componentRef.setInput("response_type", "code");
    fixture.componentRef.setInput("client_id", "kanera_client_test");
    fixture.componentRef.setInput("redirect_uri", context.redirectUri);
    fixture.componentRef.setInput("code_challenge", "x".repeat(43));
    fixture.componentRef.setInput("code_challenge_method", "S256");
    fixture.componentRef.setInput("state", "request-state");
    fixture.componentRef.setInput("resource", "https://mcp.example/mcp");
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it("shows the server-derived callback origin before approval", async () => {
    const fixture = await render();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";

    expect(text).toContain("Connect Example agent");
    expect(text).toContain("https://client.example");
    expect(text).toContain("Only continue if you started this connection");
  });

  it("keeps a denied request on Kanera until the user explicitly returns to the client", async () => {
    const fixture = await render();

    await fixture.componentInstance.cancel();
    fixture.detectChanges();

    expect(post).toHaveBeenCalledWith("/oauth/authorize/deny", expect.objectContaining({
      client_id: "kanera_client_test",
      redirect_uri: context.redirectUri,
      state: "request-state",
    }));
    expect(fixture.componentInstance.denial()?.redirectOrigin).toBe("https://client.example");
    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("Access not granted");
    expect(text).toContain("Return to client");
    expect(text).toContain("Stay in Kanera");
  });
});
