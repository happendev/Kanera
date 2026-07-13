import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../auth/auth.service";
import { UpdatesService } from "../updates/updates.service";
import { RECONNECT_WATCHDOG_MS, SOCKET_IO, SocketService } from "./socket.service";

type Handler = (...args: unknown[]) => void;

class SocketStub {
  connected = true;
  readonly io = {
    on: vi.fn(),
  };
  readonly emit = vi.fn((event: string, _payload: unknown, ack?: (ok: boolean) => void) => {
    if (event === "workspace:join") ack?.(true);
    return this;
  });
  readonly on = vi.fn((event: string, handler: Handler) => {
    const handlers = this.handlers.get(event) ?? new Set<Handler>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return this;
  });
  readonly connect = vi.fn(() => this);
  readonly disconnect = vi.fn();
  private readonly handlers = new Map<string, Set<Handler>>();

  trigger(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  reset() {
    this.handlers.clear();
    this.connected = true;
  }
}

const socket = new SocketStub();

describe("SocketService", () => {
  beforeEach(() => {
    socket.emit.mockClear();
    socket.on.mockClear();
    socket.disconnect.mockClear();
    socket.connect.mockClear();
    socket.io.on.mockClear();
    socket.reset();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        SocketService,
        {
          provide: AuthService,
          useValue: {
            getAccessToken: vi.fn(() => "token"),
            refresh: vi.fn(() => Promise.resolve(true)),
            reloadMe: vi.fn(() => Promise.resolve(true)),
            user: vi.fn(() => ({ id: "user-1" })),
          },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn(() => Promise.resolve(true)) } },
        { provide: UpdatesService, useValue: { checkForUpdate: vi.fn(() => Promise.resolve()) } },
        { provide: SOCKET_IO, useValue: vi.fn(() => socket) },
      ],
    });
  });

  it("reference-counts workspace room subscriptions", () => {
    const service = TestBed.inject(SocketService);

    const leaveFirst = service.joinWorkspace("workspace-1");
    const leaveSecond = service.joinWorkspace("workspace-1");

    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith("workspace:join", "workspace-1", expect.any(Function));

    leaveFirst();
    expect(socket.emit).toHaveBeenCalledTimes(1);

    leaveSecond();
    expect(socket.emit).toHaveBeenCalledTimes(2);
    expect(socket.emit).toHaveBeenLastCalledWith("workspace:leave", "workspace-1");
  });

  it("does not report offline while the initial socket connection is still pending", () => {
    const service = TestBed.inject(SocketService);

    expect(service.online()).toBe(true);
    service.connect();
    expect(service.online()).toBe(true);
  });

  it("reports offline after an established socket disconnects", () => {
    const service = TestBed.inject(SocketService);
    service.connect();

    socket.trigger("connect");
    expect(service.online()).toBe(true);

    socket.trigger("disconnect", "transport close");
    expect(service.online()).toBe(false);
  });

  afterEach(() => {
    // Resuming-from-sleep tests below stub navigator.onLine and document.visibilityState;
    // these are global jsdom properties, so restore their defaults for later tests.
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  // Each test constructs its own SocketService, and the constructor registers a real
  // document-level 'visibilitychange' listener that outlives the test (SocketService is a
  // root singleton with no teardown hook). Dispatching a genuine document event would also
  // fire every earlier test's leftover listener. Capturing this test's own handler and
  // invoking it directly keeps each test isolated from that accumulation.
  function captureVisibilityHandler(addEventListenerSpy: ReturnType<typeof vi.spyOn>): () => void {
    const call = addEventListenerSpy.mock.calls.find((call: unknown[]) => call[0] === "visibilitychange");
    if (!call) throw new Error("SocketService did not register a visibilitychange listener");
    return call[1] as () => void;
  }

  it("resyncs a stuck offline signal and reconnects a stalled socket when the tab becomes visible again", () => {
    // The browser's 'online' event doesn't reliably fire on resume from sleep (notably on
    // Linux/Chromium), so browserOnline can be stuck false even though the network is back.
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");
    const service = TestBed.inject(SocketService);
    const onVisibilityChange = captureVisibilityHandler(addEventListenerSpy);
    expect(service.online()).toBe(false);

    service.connect();
    socket.connected = false;
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    onVisibilityChange();

    expect(service.online()).toBe(true);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    addEventListenerSpy.mockRestore();
  });

  it("does not force a reconnect on visibility resume when the socket is already connected", () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");
    const service = TestBed.inject(SocketService);
    const onVisibilityChange = captureVisibilityHandler(addEventListenerSpy);
    service.connect();
    socket.connected = true;

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    onVisibilityChange();

    expect(socket.connect).not.toHaveBeenCalled();
    addEventListenerSpy.mockRestore();
  });

  it("ignores visibility changes that hide the tab", () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");
    const service = TestBed.inject(SocketService);
    const onVisibilityChange = captureVisibilityHandler(addEventListenerSpy);

    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    onVisibilityChange();

    expect(service.online()).toBe(false);
    addEventListenerSpy.mockRestore();
  });

  it("forces a fresh reconnect when Socket.IO stops making reconnect attempts", () => {
    vi.useFakeTimers();
    try {
      const service = TestBed.inject(SocketService);
      service.connect();
      socket.trigger("connect");
      socket.connected = false;
      socket.trigger("disconnect", "transport close");

      vi.advanceTimersByTime(RECONNECT_WATCHDOG_MS - 1);
      expect(socket.disconnect).not.toHaveBeenCalled();
      expect(socket.connect).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(socket.disconnect).toHaveBeenCalledTimes(1);
      expect(socket.connect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the reconnect watchdog once the socket reconnects", () => {
    vi.useFakeTimers();
    try {
      const service = TestBed.inject(SocketService);
      service.connect();
      socket.trigger("connect");
      socket.connected = false;
      socket.trigger("disconnect", "transport close");
      socket.connected = true;
      socket.trigger("connect");

      vi.advanceTimersByTime(RECONNECT_WATCHDOG_MS);

      expect(socket.disconnect).not.toHaveBeenCalled();
      expect(socket.connect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejoins each referenced workspace once after reconnect", () => {
    const service = TestBed.inject(SocketService);
    service.joinWorkspace("workspace-1");
    service.joinWorkspace("workspace-1");
    service.joinWorkspace("workspace-2");
    socket.emit.mockClear();

    socket.trigger("connect");

    expect(socket.emit.mock.calls).toEqual([
      ["workspace:join", "workspace-1", expect.any(Function)],
      ["workspace:join", "workspace-2", expect.any(Function)],
    ]);
  });

  it("retries a workspace join when a previous referenced join was rejected", () => {
    socket.emit.mockImplementationOnce((event: string, _payload: unknown, ack?: (ok: boolean) => void) => {
      if (event === "workspace:join") ack?.(false);
      return socket;
    });
    const service = TestBed.inject(SocketService);

    service.joinWorkspace("workspace-1");
    service.joinWorkspace("workspace-1");

    expect(socket.emit.mock.calls.filter(([event]) => event === "workspace:join")).toHaveLength(2);
  });

  it("checks for service worker updates after reconnect", () => {
    const service = TestBed.inject(SocketService);
    const updates = TestBed.inject(UpdatesService);
    service.connect();

    socket.trigger("connect");
    expect(updates.checkForUpdate).not.toHaveBeenCalled();

    socket.trigger("disconnect", "transport close");
    socket.trigger("connect");

    expect(updates.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("refreshes access and reconnects after a server-side socket eviction", async () => {
    const service = TestBed.inject(SocketService);
    const auth = TestBed.inject(AuthService) as unknown as { reloadMe: ReturnType<typeof vi.fn> };
    service.connect();

    socket.trigger("connect");
    socket.trigger("disconnect", "io server disconnect");

    expect(service.accessRefreshing()).toBe(true);
    expect(service.online()).toBe(true);
    await vi.waitFor(() => expect(auth.reloadMe).toHaveBeenCalledTimes(1));
    expect(auth.reloadMe).toHaveBeenCalledWith({ refreshToken: true });
    await vi.waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(1));
    expect(service.accessRefreshing()).toBe(false);
    expect(service.online()).toBe(true);
  });

  it("navigates to login when server-side eviction refresh clears the session", async () => {
    const authUser = vi.fn(() => null);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        SocketService,
        {
          provide: AuthService,
          useValue: {
            getAccessToken: vi.fn(() => "token"),
            refresh: vi.fn(() => Promise.resolve(null)),
            reloadMe: vi.fn(() => Promise.resolve(false)),
            user: authUser,
          },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn(() => Promise.resolve(true)) } },
        { provide: UpdatesService, useValue: { checkForUpdate: vi.fn(() => Promise.resolve()) } },
        { provide: SOCKET_IO, useValue: vi.fn(() => socket) },
      ],
    });
    const service = TestBed.inject(SocketService);
    const router = TestBed.inject(Router) as unknown as { navigateByUrl: ReturnType<typeof vi.fn> };
    service.connect();

    socket.trigger("connect");
    socket.trigger("disconnect", "io server disconnect");

    await vi.waitFor(() => expect(router.navigateByUrl).toHaveBeenCalledWith("/login", { replaceUrl: true }));
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(service.accessRefreshing()).toBe(false);
  });
});
