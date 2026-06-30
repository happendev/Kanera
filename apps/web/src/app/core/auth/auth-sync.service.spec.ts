import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { SERVER_EVENTS, type ServerToClientEvents } from "@kanera/shared/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SocketService, type AppSocket } from "../realtime/socket.service";
import { AuthService, type AuthUser } from "./auth.service";
import { AuthSyncService } from "./auth-sync.service";

class SocketStub {
  readonly on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = this.handlers.get(event) ?? new Set<(...args: unknown[]) => void>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return this;
  });
  readonly off = vi.fn();
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  trigger<E extends keyof ServerToClientEvents>(event: E, payload: Parameters<ServerToClientEvents[E]>[0]) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  asSocket(): AppSocket {
    return this as unknown as AppSocket;
  }
}

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
    timezone: "Europe/Dublin",
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

describe("AuthSyncService", () => {
  let socket: SocketStub;
  let authUser: ReturnType<typeof signal<AuthUser | null>>;
  let reloadMe: ReturnType<typeof vi.fn>;
  let connect: ReturnType<typeof vi.fn>;
  let disconnect: ReturnType<typeof vi.fn>;
  let navigateByUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    socket = new SocketStub();
    authUser = signal(user());
    reloadMe = vi.fn(() => Promise.resolve(true));
    connect = vi.fn(() => socket.asSocket());
    disconnect = vi.fn();
    navigateByUrl = vi.fn(() => Promise.resolve(true));

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        AuthSyncService,
        {
          provide: AuthService,
          useValue: {
            user: authUser.asReadonly(),
            reloadMe,
            isLogoutSyncEvent: vi.fn(() => false),
            clearSession: vi.fn(() => authUser.set(null)),
          },
        },
        { provide: SocketService, useValue: { connect, disconnect } },
        { provide: Router, useValue: { navigateByUrl } },
      ],
    });
    TestBed.inject(AuthSyncService);
    TestBed.tick();
  });

  it("waits for a signed-in user before attaching entitlement sync", () => {
    TestBed.resetTestingModule();
    socket = new SocketStub();
    authUser = signal<AuthUser | null>(null);
    connect = vi.fn(() => socket.asSocket());

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        AuthSyncService,
        {
          provide: AuthService,
          useValue: {
            user: authUser.asReadonly(),
            reloadMe,
            isLogoutSyncEvent: vi.fn(() => false),
            clearSession: vi.fn(() => authUser.set(null)),
          },
        },
        { provide: SocketService, useValue: { connect, disconnect } },
        { provide: Router, useValue: { navigateByUrl } },
      ],
    });
    TestBed.inject(AuthSyncService);
    TestBed.tick();

    expect(connect).not.toHaveBeenCalled();

    authUser.set(user());
    TestBed.tick();

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("reloads the current account when entitlements change for this client", async () => {
    socket.trigger(SERVER_EVENTS.CLIENT_ENTITLEMENTS_CHANGED, { clientId: "client-1" });
    await Promise.resolve();

    expect(reloadMe).toHaveBeenCalledTimes(1);
  });

  it("ignores entitlement changes for another client", async () => {
    socket.trigger(SERVER_EVENTS.CLIENT_ENTITLEMENTS_CHANGED, { clientId: "client-2" });
    await Promise.resolve();

    expect(reloadMe).not.toHaveBeenCalled();
  });

  it("coalesces duplicate entitlement changes while a reload is in flight", async () => {
    const first = deferred<boolean>();
    reloadMe.mockReturnValueOnce(first.promise).mockResolvedValue(true);

    socket.trigger(SERVER_EVENTS.CLIENT_ENTITLEMENTS_CHANGED, { clientId: "client-1" });
    socket.trigger(SERVER_EVENTS.CLIENT_ENTITLEMENTS_CHANGED, { clientId: "client-1" });
    await Promise.resolve();

    expect(reloadMe).toHaveBeenCalledTimes(1);

    first.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(reloadMe).toHaveBeenCalledTimes(2);
  });

  it("navigates to login if the entitlement refresh clears the session", async () => {
    reloadMe.mockImplementation(async () => {
      authUser.set(null);
      return false;
    });

    socket.trigger(SERVER_EVENTS.CLIENT_ENTITLEMENTS_CHANGED, { clientId: "client-1" });
    await Promise.resolve();
    await Promise.resolve();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(navigateByUrl).toHaveBeenCalledWith("/login");
  });
});
