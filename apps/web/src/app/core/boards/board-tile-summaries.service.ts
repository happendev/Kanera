import { Injectable, inject } from "@angular/core";
import type { BoardTileSummary } from "@kanera/shared/dto";
import { ApiClient } from "../api/api.client";

/** Mirrors BOARD_TILE_SUMMARY_MAX_BOARDS in @kanera/shared/dto; the web may import only types from it. */
const MAX_BOARDS = 100;

/**
 * Fetches the counts row for a set of board tiles (the workspace settings board list).
 *
 * Resolves to an empty list on any failure, including offline: a board tile without its counts
 * row is still a working tile, and a missing row must never take the tile with it.
 */
@Injectable({ providedIn: "root" })
export class BoardTileSummariesService {
  private readonly api = inject(ApiClient);

  async load(boardIds: readonly string[]): Promise<BoardTileSummary[]> {
    if (boardIds.length === 0) return [];
    try {
      return await this.api.post<BoardTileSummary[]>("/boards/tile-summaries/query", { boardIds: boardIds.slice(0, MAX_BOARDS) });
    } catch {
      return [];
    }
  }
}
