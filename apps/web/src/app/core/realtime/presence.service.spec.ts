import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import { SocketService } from "./socket.service";
import { PresenceService } from "./presence.service";

type Handler = (payload: unknown) => void;

class SocketStub {
  readonly handlers = new Map<string, Handler>();
  readonly on = vi.fn((event: string, handler: Handler) => {
    this.handlers.set(event, handler);
    return this;
  });

  trigger(event: string, payload: unknown) {
    this.handlers.get(event)?.(payload);
  }
}

describe("PresenceService", () => {
  it("applies snapshots and incremental changes", () => {
    const socket = new SocketStub();
    const leaveWorkspace = vi.fn();
    const joinWorkspace = vi.fn(() => leaveWorkspace);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        PresenceService,
        { provide: SocketService, useValue: { connect: vi.fn(() => socket), joinWorkspace } },
      ],
    });

    const service = TestBed.inject(PresenceService);
    expect(service.isOnline("workspace-1", "user-1")).toBe(false);
    const unwatch = service.watchWorkspace("workspace-1");
    expect(joinWorkspace).toHaveBeenCalledWith("workspace-1");
    socket.trigger("presence:snapshot", { workspaceId: "workspace-1", onlineUserIds: ["user-1"] });
    expect(service.isOnline("workspace-1", "user-1")).toBe(true);
    expect(service.isOnline("workspace-1", "user-2")).toBe(false);

    socket.trigger("presence:changed", { workspaceId: "workspace-1", userId: "user-2", online: true });
    expect(service.isOnline("workspace-1", "user-2")).toBe(true);

    socket.trigger("presence:changed", { workspaceId: "workspace-1", userId: "user-1", online: false });
    expect(service.isOnline("workspace-1", "user-1")).toBe(false);
    unwatch();
    expect(leaveWorkspace).toHaveBeenCalledTimes(1);
  });

  it("keeps the latest offline timestamp from presence changes", () => {
    const socket = new SocketStub();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        PresenceService,
        { provide: SocketService, useValue: { connect: vi.fn(() => socket), joinWorkspace: vi.fn(() => vi.fn()) } },
      ],
    });

    const service = TestBed.inject(PresenceService);
    service.watchWorkspace("workspace-1");

    socket.trigger("presence:changed", { workspaceId: "workspace-1", userId: "user-1", online: false, lastOnlineAt: "2026-06-21T12:00:00.000Z" });
    expect(service.lastOnlineAt("workspace-1", "user-1")).toBe("2026-06-21T12:00:00.000Z");

    socket.trigger("presence:changed", { workspaceId: "workspace-1", userId: "user-1", online: true });
    socket.trigger("presence:changed", { workspaceId: "workspace-1", userId: "user-1", online: false, lastOnlineAt: "2026-06-21T12:01:00.000Z" });

    expect(service.lastOnlineAt("workspace-1", "user-1")).toBe("2026-06-21T12:01:00.000Z");
  });

  it("keeps the last snapshot when avatar watchers are recreated during navigation", () => {
    const socket = new SocketStub();
    let roomRefCount = 0;
    const leaveWorkspace = vi.fn(() => {
      roomRefCount -= 1;
    });
    const joinWorkspace = vi.fn((_workspaceId: string) => {
      roomRefCount += 1;
      return leaveWorkspace;
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        PresenceService,
        { provide: SocketService, useValue: { connect: vi.fn(() => socket), joinWorkspace } },
      ],
    });

    const service = TestBed.inject(PresenceService);
    const leavePageSubscription = joinWorkspace("workspace-1");
    const unwatch = service.watchWorkspace("workspace-1");
    socket.trigger("presence:snapshot", { workspaceId: "workspace-1", onlineUserIds: ["user-1", "user-2"] });

    unwatch();

    expect(roomRefCount).toBe(1);
    expect(service.isOnline("workspace-1", "user-2")).toBe(true);

    const rewatch = service.watchWorkspace("workspace-1");
    expect(service.isOnline("workspace-1", "user-2")).toBe(true);

    rewatch();
    leavePageSubscription();
  });
});
