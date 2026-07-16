import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { BoardMirrorsService } from "./board-mirrors.service";

describe("BoardMirrorsService", () => {
  const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  let service: BoardMirrorsService;

  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset().mockResolvedValue({}));
    TestBed.configureTestingModule({ providers: [BoardMirrorsService, { provide: ApiClient, useValue: api }] });
    service = TestBed.inject(BoardMirrorsService);
  });

  it("uses the source and target ownership URL shapes", async () => {
    await service.targetBoards("source board");
    expect(api.get).toHaveBeenCalledWith("/mirror-target-boards?sourceBoardId=source%20board");
    await service.status("source");
    expect(api.get).toHaveBeenCalledWith("/boards/source/mirror-status");
    await service.create("source", { targetBoardId: "target", lists: [{ sourceListId: "list-a", targetListId: "list-b" }] });
    expect(api.post).toHaveBeenCalledWith("/boards/source/mirrors", { targetBoardId: "target", lists: [{ sourceListId: "list-a", targetListId: "list-b" }] });
    await service.update("target", "mirror", { paused: true });
    expect(api.patch).toHaveBeenCalledWith("/boards/target/mirrors/mirror", { paused: true });
    await service.sourceDisable("source", "mirror");
    expect(api.post).toHaveBeenCalledWith("/boards/source/mirrors/mirror/source-disable", {});
    await service.remove("target", "mirror");
    expect(api.delete).toHaveBeenCalledWith("/boards/target/mirrors/mirror");
  });
});
