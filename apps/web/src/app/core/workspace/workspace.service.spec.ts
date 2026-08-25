import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/api.client";
import { WorkspaceService } from "./workspace.service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("WorkspaceService", () => {
  function setup() {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        WorkspaceService,
        { provide: ApiClient, useValue: { get: vi.fn() } },
      ],
    });
    return TestBed.inject(WorkspaceService);
  }

  it("derives notification board and user options from registered workspace data", () => {
    const service = setup();

    service.registerBoards("workspace-1", [
      { id: "board-2", name: "Zeta", icon: "bolt", iconColor: "teal" },
      { id: "board-1", name: "Alpha", icon: null, iconColor: null },
    ]);
    service.registerMembers("workspace-1", [
      { userId: "user-2", displayName: "Grace", avatarUrl: null },
      { userId: "user-1", displayName: "Ada", avatarUrl: "https://example.test/ada.png" },
    ]);
    service.registerMembers("workspace-2", [
      { userId: "user-2", displayName: "Grace", avatarUrl: null },
      { userId: "user-3", displayName: "Linus", avatarUrl: null },
    ]);

    expect(service.notificationBoardOptions()).toEqual([
      { boardId: "board-1", boardName: "Alpha", boardIcon: null, boardIconColor: null },
      { boardId: "board-2", boardName: "Zeta", boardIcon: "bolt", boardIconColor: "teal" },
    ]);
    expect(service.notificationUserOptions().map((user) => user.userId)).toEqual(["user-1", "user-2", "user-3"]);
  });

  it("keeps notification user options in sync with workspace membership changes", () => {
    const service = setup();

    service.registerMembers("workspace-1", [{ userId: "user-1", displayName: "Ada", avatarUrl: null }]);
    service.upsertMember("workspace-1", { userId: "user-2", displayName: "Grace", avatarUrl: null });
    service.removeMember("workspace-1", "user-1");

    expect(service.notificationUserOptions()).toEqual([
      { userId: "user-2", displayName: "Grace", avatarUrl: null },
    ]);
  });

  it("updates a user's profile in every registered workspace", () => {
    const service = setup();
    service.registerMembers("workspace-1", [{ userId: "user-1", displayName: "Ada", avatarUrl: null }]);
    service.registerMembers("workspace-2", [{ userId: "user-1", displayName: "Ada", avatarUrl: null }]);

    service.updateMemberProfile("user-1", "Ada Lovelace", "/avatars/ada.jpg");

    expect(service.notificationUserOptions()).toEqual([
      { userId: "user-1", displayName: "Ada Lovelace", avatarUrl: "/avatars/ada.jpg" },
    ]);
  });

  it("keeps notification board options in sync with board realtime changes", () => {
    const service = setup();

    service.registerBoards("workspace-1", [{ id: "board-1", name: "Delivery", icon: null, iconColor: null }]);
    service.upsertBoard("workspace-1", { id: "board-2", name: "Automation", icon: "bolt", iconColor: "teal" });
    service.upsertBoard("workspace-1", { id: "board-1", name: "Delivery Ops", icon: "truck", iconColor: "blue" });
    service.removeBoard("board-2");

    expect(service.notificationBoardOptions()).toEqual([
      { boardId: "board-1", boardName: "Delivery Ops", boardIcon: "truck", boardIconColor: "blue" },
    ]);
  });

  it("deduplicates list loads and discards a response that crosses a cache clear", async () => {
    const response = deferred<{ lists: Array<{
      id: string;
      workspaceId: string;
      name: string;
      icon: string | null;
      color: null;
      position: string;
      archivedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    }> }>();
    const get = vi.fn(() => response.promise);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        WorkspaceService,
        { provide: ApiClient, useValue: { get } },
      ],
    });
    const service = TestBed.inject(WorkspaceService);
    service.registerBoards("workspace-1", [{ id: "board-1" }]);

    const first = service.loadLists("workspace-1");
    const duplicate = service.loadLists("workspace-1");
    expect(get).toHaveBeenCalledTimes(1);

    service.clear();
    service.registerBoards("workspace-1", [{ id: "board-1" }]);
    const now = new Date();
    response.resolve({
      lists: [{
        id: "list-1",
        workspaceId: "workspace-1",
        name: "Todo",
        icon: "list",
        color: null,
        position: "1000",
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      }],
    });
    await Promise.all([first, duplicate]);

    expect(service.listsForBoard("board-1")).toEqual([]);
  });
});
