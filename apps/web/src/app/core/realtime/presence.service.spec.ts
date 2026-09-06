import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SocketService } from "./socket.service";
import { PresenceService } from "./presence.service";

type Handler = (payload: unknown) => void;

class SocketStub {
  readonly handlers = new Map<string, Handler>();
  readonly on = vi.fn((event: string, handler: Handler) => {
    this.handlers.set(event, handler);
    return this;
  });
  readonly off = vi.fn((event: string, handler: Handler) => {
    if (this.handlers.get(event) === handler) this.handlers.delete(event);
    return this;
  });

  trigger(event: string, payload: unknown) {
    this.handlers.get(event)?.(payload);
  }
}

function setup() {
  const socket = new SocketStub();
  const refs = new Map<string, number>();
  const activeWorkspaceIds = signal<ReadonlySet<string>>(new Set());
  const joinWorkspace = vi.fn((id: string) => {
    refs.set(id, (refs.get(id) ?? 0) + 1);
    activeWorkspaceIds.set(new Set(refs.keys()));
    return vi.fn(() => {
      const count = (refs.get(id) ?? 1) - 1;
      if (count) refs.set(id, count);
      else refs.delete(id);
      activeWorkspaceIds.set(new Set(refs.keys()));
    });
  });
  const connect = vi.fn(() => socket);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(), PresenceService,
      { provide: SocketService, useValue: { connect, joinWorkspace, activeWorkspaceIds } },
    ],
  });
  return { service: TestBed.inject(PresenceService), socket, joinWorkspace, activeWorkspaceIds, connect };
}

const offline = (workspaceId: string, userId = "user-1") => ({
  workspaceId, userId, online: false, lastOnlineAt: "2026-06-21T12:00:00.000Z",
});

afterEach(() => TestBed.resetTestingModule());

describe("PresenceService", () => {
  it("applies snapshots, changes and last-online timestamps", () => {
    const { service, socket, joinWorkspace } = setup();
    expect(service.isOnline("workspace-1", "user-1")).toBe(false);
    service.watchWorkspace("workspace-1");
    expect(joinWorkspace).toHaveBeenCalledWith("workspace-1");
    socket.trigger("presence:snapshot", { workspaceId: "workspace-1", onlineUserIds: ["user-1"] });
    expect(service.isOnline("workspace-1", "user-1")).toBe(true);
    expect(service.isOnline("workspace-1", "user-2")).toBe(false);
    socket.trigger("presence:changed", { workspaceId: "workspace-1", userId: "user-2", online: true });
    expect(service.isOnline("workspace-1", "user-2")).toBe(true);
    socket.trigger("presence:changed", offline("workspace-1"));
    expect(service.isOnline("workspace-1", "user-1")).toBe(false);
    expect(service.lastOnlineAt("workspace-1", "user-1")).toBe(offline("workspace-1").lastOnlineAt);
    socket.trigger("presence:changed", { ...offline("workspace-1"), lastOnlineAt: "2026-06-21T12:01:00.000Z" });
    expect(service.lastOnlineAt("workspace-1", "user-1")).toBe("2026-06-21T12:01:00.000Z");
  });

  it("retains snapshots while a page owns the room, then clears on the final release", () => {
    const { service, socket, joinWorkspace } = setup();
    const leavePage = joinWorkspace("workspace-1");
    const unwatch = service.watchWorkspace("workspace-1");
    socket.trigger("presence:snapshot", { workspaceId: "workspace-1", onlineUserIds: ["user-2"] });
    socket.trigger("presence:changed", offline("workspace-1"));
    unwatch();
    TestBed.tick();
    expect(service.isOnline("workspace-1", "user-2")).toBe(true);
    const rewatch = service.watchWorkspace("workspace-1");
    expect(service.isOnline("workspace-1", "user-2")).toBe(true);
    rewatch();
    leavePage();
    TestBed.tick();
    expect(service.isOnline("workspace-1", "user-2")).toBe(false);
    expect(service.lastOnlineAt("workspace-1", "user-1")).toBe(null);
  });

  it("keeps shared avatar watchers alive and ignores duplicate disposals", () => {
    const { service, socket, activeWorkspaceIds } = setup();
    const first = service.watchWorkspace("workspace-1");
    const second = service.watchWorkspace("workspace-1");
    socket.trigger("presence:snapshot", { workspaceId: "workspace-1", onlineUserIds: ["user-1"] });
    first(); first(); TestBed.tick();
    expect(service.isOnline("workspace-1", "user-1")).toBe(true);
    second(); TestBed.tick();
    expect(activeWorkspaceIds().size).toBe(0);
    expect(service.isOnline("workspace-1", "user-1")).toBe(false);
  });

  it("releases visited workspaces and ignores late or unwatched workspace events", () => {
    const { service, socket } = setup();
    for (let i = 0; i < 100; i++) {
      const id = `workspace-${i}`;
      const leave = service.watchWorkspace(id);
      socket.trigger("presence:changed", offline(id));
      leave(); TestBed.tick();
      socket.trigger("presence:snapshot", { workspaceId: id, onlineUserIds: ["user-1"] });
      socket.trigger("presence:changed", offline(id));
      expect(service.isOnline(id, "user-1")).toBe(false);
      expect(service.lastOnlineAt(id, "user-1")).toBe(null);
    }
  });

  it("clears cached data when the socket service releases all rooms on logout", () => {
    const { service, socket, activeWorkspaceIds } = setup();
    service.watchWorkspace("workspace-1");
    socket.trigger("presence:snapshot", { workspaceId: "workspace-1", onlineUserIds: ["user-2"] });
    socket.trigger("presence:changed", offline("workspace-1"));
    activeWorkspaceIds.set(new Set()); TestBed.tick();
    expect(service.isOnline("workspace-1", "user-2")).toBe(false);
    expect(service.lastOnlineAt("workspace-1", "user-1")).toBe(null);
  });

  it("bounds historical offline users even while a workspace stays open", () => {
    const { service, socket } = setup();
    service.watchWorkspace("workspace-1");
    for (let i = 0; i < 1_001; i++) socket.trigger("presence:changed", offline("workspace-1", `user-${i}`));
    expect(service.lastOnlineAt("workspace-1", "user-0")).toBe(null);
    expect(service.lastOnlineAt("workspace-1", "user-1000")).toBe(offline("workspace-1").lastOnlineAt);
  });

  it("rebinds replacement sockets and detaches handlers on service destruction", () => {
    const { service, socket, connect } = setup();
    service.watchWorkspace("workspace-1")();
    const replacement = new SocketStub();
    connect.mockReturnValue(replacement);
    service.watchWorkspace("workspace-2");
    expect(socket.handlers.size).toBe(0);
    replacement.trigger("presence:snapshot", { workspaceId: "workspace-2", onlineUserIds: ["user-1"] });
    expect(service.isOnline("workspace-2", "user-1")).toBe(true);
    TestBed.resetTestingModule();
    expect(replacement.handlers.size).toBe(0);
  });
});
