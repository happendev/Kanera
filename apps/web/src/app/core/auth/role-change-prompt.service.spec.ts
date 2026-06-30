import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { ServerToClientEvents } from "@kanera/shared/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SocketService, type AppSocket } from "../realtime/socket.service";
import { AuthService, type AuthUser } from "./auth.service";
import { RoleChangePromptService } from "./role-change-prompt.service";

class SocketStub {
  readonly on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = this.handlers.get(event) ?? new Set<(...args: unknown[]) => void>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return this;
  });
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
    deploymentMode: "self_hosted",
    hasWorkspace: true,
    role: "member",
    timezone: "Europe/Dublin",
    ...overrides,
  };
}

describe("RoleChangePromptService", () => {
  let socket: SocketStub;
  let authUser: ReturnType<typeof signal<AuthUser | null>>;
  let service: RoleChangePromptService;

  beforeEach(() => {
    socket = new SocketStub();
    authUser = signal(user());

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        RoleChangePromptService,
        { provide: AuthService, useValue: { user: authUser.asReadonly() } },
        { provide: SocketService, useValue: { connect: vi.fn(() => socket.asSocket()) } },
      ],
    });
    service = TestBed.inject(RoleChangePromptService);
  });

  it("shows the prompt when my organisation role changes", () => {
    socket.trigger("client:user:role-changed", { userId: "user-1", role: "admin" });

    expect(service.refreshRequired()).toBe(true);
  });

  it("ignores another user's organisation role change", () => {
    socket.trigger("client:user:role-changed", { userId: "user-2", role: "admin" });

    expect(service.refreshRequired()).toBe(false);
  });

  it("shows the prompt when my workspace role changes", () => {
    socket.trigger("workspace:member:updated", {
      workspaceId: "workspace-1",
      member: {
        workspaceId: "workspace-1",
        userId: "user-1",
        role: "admin",
        addedAt: new Date(),
      },
    });

    expect(service.refreshRequired()).toBe(true);
  });

  it("ignores another user's workspace role change", () => {
    socket.trigger("workspace:member:updated", {
      workspaceId: "workspace-1",
      member: {
        workspaceId: "workspace-1",
        userId: "user-2",
        role: "admin",
        addedAt: new Date(),
      },
    });

    expect(service.refreshRequired()).toBe(false);
  });
});
