import { Injectable, inject } from "@angular/core";
import type { BoardMirrorRow, BoardMirrorStatus, CardMirrorStatus, CreateBoardMirrorBody, MirrorSourceBoardsResponse, MirrorTargetBoardsResponse, UpdateBoardMirrorBody } from "@kanera/shared/dto";
import { ApiClient } from "../../core/api/api.client";

@Injectable({ providedIn: "root" })
export class BoardMirrorsService {
  private readonly api = inject(ApiClient);

  targetBoards(sourceBoardId: string) {
    return this.api.get<MirrorTargetBoardsResponse>(`/mirror-target-boards?sourceBoardId=${encodeURIComponent(sourceBoardId)}`);
  }

  sourceBoards(targetBoardId: string) {
    return this.api.get<MirrorSourceBoardsResponse>(`/mirror-source-boards?targetBoardId=${encodeURIComponent(targetBoardId)}`);
  }

  status(boardId: string) {
    return this.api.get<BoardMirrorStatus>(`/boards/${boardId}/mirror-status`);
  }

  create(sourceBoardId: string, body: CreateBoardMirrorBody) {
    return this.api.post<BoardMirrorRow>(`/boards/${sourceBoardId}/mirrors`, body);
  }

  inbound(targetBoardId: string) {
    return this.api.get<BoardMirrorRow[]>(`/boards/${targetBoardId}/mirrors`);
  }

  outbound(sourceBoardId: string) {
    return this.api.get<BoardMirrorRow[]>(`/boards/${sourceBoardId}/outbound-mirrors`);
  }

  update(targetBoardId: string, mirrorId: string, body: UpdateBoardMirrorBody) {
    return this.api.patch<BoardMirrorRow>(`/boards/${targetBoardId}/mirrors/${mirrorId}`, body);
  }

  sourceDisable(sourceBoardId: string, mirrorId: string) {
    return this.api.post<{ ok: true }>(`/boards/${sourceBoardId}/mirrors/${mirrorId}/source-disable`, {});
  }

  sourceEnable(sourceBoardId: string, mirrorId: string) {
    return this.api.post<{ ok: true }>(`/boards/${sourceBoardId}/mirrors/${mirrorId}/source-enable`, {});
  }

  remove(targetBoardId: string, mirrorId: string) {
    return this.api.delete<void>(`/boards/${targetBoardId}/mirrors/${mirrorId}`);
  }

  cardStatus(cardId: string) {
    return this.api.get<CardMirrorStatus>(`/cards/${cardId}/mirrors`);
  }
}
