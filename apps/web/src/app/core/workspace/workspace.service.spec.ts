import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/api.client";
import { WorkspaceService } from "./workspace.service";

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
});
