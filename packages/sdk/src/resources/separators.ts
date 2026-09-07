import type { BoardSeparator, ColorToken, LanePositionAnchor, Uuid } from "../types.js";
import type { CallOptions, ResourceContext } from "./base.js";

interface SeparatorAppearanceInput {
  title?: string;
  color?: ColorToken | null;
}

export type CreateSeparatorInput = SeparatorAppearanceInput &
  (
    | {
        /**
         * Exact initial location in the mixed card-and-separator lane. Omit to append at the
         * bottom; a null anchor item means the top for `side: "after"`.
         */
        anchor?: LanePositionAnchor;
        atTop?: never;
      }
    | {
        /** Legacy edge shorthand. Do not combine with anchor. */
        atTop?: boolean;
        anchor?: never;
      }
  );

/** At least one appearance field is required. */
export type UpdateSeparatorInput =
  | { title: string; color?: ColorToken | null }
  | { title?: string; color: ColorToken | null };

export interface MoveSeparatorInput {
  listId: Uuid;
  anchor: LanePositionAnchor;
}

export interface SeparatorMoveResult {
  id: Uuid;
  listId: Uuid;
  position: string;
}

function anchorBody(anchor: LanePositionAnchor) {
  return anchor.side === "after" ? { afterItem: anchor.item } : { beforeItem: anchor.item };
}

/** Create and manage first-class dividers in a board's workflow-list lanes. */
export class Separators {
  constructor(private readonly ctx: ResourceContext) {}

  create(
    boardId: Uuid,
    listId: Uuid,
    body: CreateSeparatorInput = {},
    options: CallOptions = {},
  ): Promise<BoardSeparator> {
    const { anchor, ...fields } = body;
    return this.ctx.http.post<BoardSeparator>(`/api/v1/boards/${boardId}/lists/${listId}/separators`, {
      ...fields,
      ...(anchor ? anchorBody(anchor) : {}),
    }, options);
  }

  update(separatorId: Uuid, body: UpdateSeparatorInput, options: CallOptions = {}): Promise<BoardSeparator> {
    return this.ctx.http.patch<BoardSeparator>(`/api/v1/separators/${separatorId}`, body, options);
  }

  move(separatorId: Uuid, body: MoveSeparatorInput, options: CallOptions = {}): Promise<SeparatorMoveResult> {
    return this.ctx.http.post<SeparatorMoveResult>(`/api/v1/separators/${separatorId}/move`, {
      listId: body.listId,
      ...anchorBody(body.anchor),
    }, options);
  }

  async delete(separatorId: Uuid, options: CallOptions = {}): Promise<void> {
    await this.ctx.http.delete(`/api/v1/separators/${separatorId}`, options);
  }
}
