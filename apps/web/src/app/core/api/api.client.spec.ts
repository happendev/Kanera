import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../auth/auth.service";
import { SocketService } from "../realtime/socket.service";
import { ApiClient, ORGANISATION_SWITCH_NAVIGATOR } from "./api.client";

class MockXmlHttpRequest extends EventTarget {
  static instances: MockXmlHttpRequest[] = [];
  readonly upload = new EventTarget();
  readonly headers = new Map<string, string>();
  status = 0;
  responseText = "";
  withCredentials = false;
  method = "";
  url = "";
  body: Document | XMLHttpRequestBodyInit | null = null;
  aborted = false;

  constructor() {
    super();
    MockXmlHttpRequest.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.body = body;
  }

  abort(): void {
    this.aborted = true;
    this.dispatchEvent(new Event("abort"));
  }
}

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
    MockXmlHttpRequest.instances = [];
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

  it("reports upload progress and resolves a successful XHR response", async () => {
    vi.stubGlobal("XMLHttpRequest", MockXmlHttpRequest);
    const onProgress = vi.fn();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const upload = TestBed.inject(ApiClient).upload<{ id: string }>("/attachments", new FormData(), {
      onProgress,
      signal: controller.signal,
    });
    const xhr = MockXmlHttpRequest.instances[0]!;

    xhr.upload.dispatchEvent(new ProgressEvent("progress", { lengthComputable: true, loaded: 3, total: 4 }));
    xhr.status = 201;
    xhr.responseText = JSON.stringify({ id: "attachment-1" });
    xhr.dispatchEvent(new Event("load"));

    await expect(upload).resolves.toEqual({ id: "attachment-1" });
    expect(onProgress).toHaveBeenCalledWith(75);
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers.get("Authorization")).toBe("Bearer client-1-token");
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("rejects an already-aborted upload without constructing an XHR", async () => {
    const xhrConstructor = vi.fn();
    vi.stubGlobal("XMLHttpRequest", xhrConstructor);
    const controller = new AbortController();
    controller.abort();

    await expect(TestBed.inject(ApiClient).upload("/attachments", new FormData(), { signal: controller.signal }))
      .rejects.toMatchObject({ status: 0, body: { message: "Upload cancelled" } });
    expect(xhrConstructor).not.toHaveBeenCalled();
  });

  it("aborts an in-flight upload", async () => {
    vi.stubGlobal("XMLHttpRequest", MockXmlHttpRequest);
    const controller = new AbortController();
    const upload = TestBed.inject(ApiClient).upload("/attachments", new FormData(), { signal: controller.signal });
    const xhr = MockXmlHttpRequest.instances[0]!;

    controller.abort();

    await expect(upload).rejects.toMatchObject({ status: 0, body: { message: "Upload cancelled" } });
    expect(xhr.aborted).toBe(true);
  });

  it("refreshes once and retries an upload after a 401", async () => {
    vi.stubGlobal("XMLHttpRequest", MockXmlHttpRequest);
    auth.refresh.mockResolvedValueOnce("fresh-token");
    const upload = TestBed.inject(ApiClient).upload<{ id: string }>("/attachments", new FormData());
    const first = MockXmlHttpRequest.instances[0]!;
    first.status = 401;
    first.responseText = JSON.stringify({ message: "expired" });
    first.dispatchEvent(new Event("load"));

    await vi.waitFor(() => expect(MockXmlHttpRequest.instances).toHaveLength(2));
    const second = MockXmlHttpRequest.instances[1]!;
    second.status = 200;
    second.responseText = JSON.stringify({ id: "attachment-1" });
    second.dispatchEvent(new Event("load"));

    await expect(upload).resolves.toEqual({ id: "attachment-1" });
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(second.headers.get("Authorization")).toBe("Bearer fresh-token");
  });
});
