import { paginateCursor, type PageIterator } from "../pagination.js";
import type {
  Attachment, BulkArchiveResult, BulkCardResult, Card, CardDetail, Checklist, ChecklistItem, DueDateSlot, LocalDate,
  PositionAnchor, Uuid,
} from "../types.js";
import type { CallOptions, ResourceContext } from "./base.js";

export interface CreateCardInput {
  title: string;
  description?: string;
  atTop?: boolean;
  assigneeIds?: Uuid[];
}

export interface UpdateCardInput {
  title?: string;
  description?: string | null;
  dueDateLocalDate?: LocalDate | null;
  dueDateSlot?: DueDateSlot | null;
}

export interface CreateChecklistItemInput {
  /** The item's label. Named `text`, not `title` — a checklist's own name is its `title`. */
  text: string;
}

export interface UpdateChecklistItemInput {
  text?: string;
  description?: string | null;
  completed?: boolean;
  assigneeId?: Uuid | null;
  dueDateLocalDate?: LocalDate | null;
  dueDateSlot?: DueDateSlot | null;
}

export interface MoveCardInput {
  listId: Uuid;
  /** Exactly one anchor. A null id means the edge of the list. */
  anchor: PositionAnchor;
}

/**
 * A custom field value is written to the column matching the field's type — the API takes
 * `{ valueText: "x" }`, never a bare value. Supply exactly the column for the target field's type;
 * the endpoint rejects a column its type does not store. `null` clears the value.
 */
export interface CustomFieldValueInput {
  valueText?: string | null;
  valueNumber?: number | string | null;
  valueCheckbox?: boolean | null;
  /** Local date, `YYYY-MM-DD`. */
  valueDate?: LocalDate | null;
  valueUrl?: string | null;
  valueOptionIds?: Uuid[] | null;
  valueUserIds?: Uuid[] | null;
}

export class Cards {
  readonly attachments: CardAttachments;
  readonly checklists: Checklists;
  readonly bulk: BulkCards;

  // Assigned in the body, not as field initialisers: class fields run before a parameter property
  // is assigned, so an initialiser referencing `this.ctx` would read undefined.
  constructor(private readonly ctx: ResourceContext) {
    this.attachments = new CardAttachments(ctx);
    this.checklists = new Checklists(ctx);
    this.bulk = new BulkCards(ctx);
  }

  /** Full card detail. `card` accepts a UUID, a key such as `MKT-42`, or a canonical card URL. */
  async get(card: string, options: CallOptions = {}): Promise<CardDetail> {
    return this.ctx.http.get<CardDetail>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/detail`, options);
  }

  /** Resolve a key or URL to the UUID the other methods use, without fetching the card. */
  resolveId(card: string): Promise<Uuid> {
    return this.ctx.resolveCard(card);
  }

  /** Look up a card by its human key within one organisation, avoiding the cross-org search. */
  byKey(organisationKey: string, cardKey: string, options: CallOptions = {}): Promise<Card> {
    return this.ctx.http.get<Card>(
      `/api/v1/organisations/${encodeURIComponent(organisationKey)}/cards/by-key/${encodeURIComponent(cardKey)}`,
      options,
    );
  }

  create(boardId: Uuid, listId: Uuid, body: CreateCardInput, options: CallOptions = {}): Promise<Card> {
    return this.ctx.http.post<Card>(`/api/v1/boards/${boardId}/lists/${listId}/cards`, body, options);
  }

  async update(card: string, body: UpdateCardInput, options: CallOptions = {}): Promise<Card> {
    return this.ctx.http.patch<Card>(`/api/v1/cards/${await this.ctx.resolveCard(card)}`, body, options);
  }

  async move(card: string, body: MoveCardInput, options: CallOptions = {}): Promise<Card> {
    const anchorBody = body.anchor.side === "after" ? { afterCardId: body.anchor.id } : { beforeCardId: body.anchor.id };
    return this.ctx.http.post<Card>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/move`, {
      listId: body.listId,
      ...anchorBody,
    }, options);
  }

  async moveToBoard(card: string, body: { boardId: Uuid; listId?: Uuid }, options: CallOptions = {}): Promise<Card> {
    return this.ctx.http.post<Card>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/move-to-board`, body, options);
  }

  async duplicate(
    card: string,
    body: { boardId?: Uuid; listId?: Uuid; atTop?: boolean } = {},
    options: CallOptions = {},
  ): Promise<Card> {
    return this.ctx.http.post<Card>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/duplicate`, body, options);
  }

  /** Completion is separate from archiving: a completed card stays on the board. */
  async setCompletion(card: string, completed: boolean, options: CallOptions = {}): Promise<Card> {
    return this.ctx.http.patch<Card>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/completion`, { completed }, options);
  }

  async setArchived(card: string, archived: boolean, options: CallOptions = {}): Promise<Card> {
    return this.ctx.http.patch<Card>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/archive`, { archived }, options);
  }

  /** Replaces the whole set; pass the full list of label ids you want on the card. */
  async setLabels(card: string, labelIds: Uuid[], options: CallOptions = {}): Promise<void> {
    return this.ctx.http.put<void>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/labels`, { labelIds }, options);
  }

  async setAssignees(card: string, userIds: Uuid[], options: CallOptions = {}): Promise<void> {
    return this.ctx.http.put<void>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/assignees`, { userIds }, options);
  }

  async setCustomField(card: string, fieldId: Uuid, value: CustomFieldValueInput, options: CallOptions = {}): Promise<void> {
    return this.ctx.http.put<void>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/custom-fields/${fieldId}`, value, options);
  }

  async clearCustomField(card: string, fieldId: Uuid, options: CallOptions = {}): Promise<void> {
    return this.ctx.http.delete<void>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/custom-fields/${fieldId}`, options);
  }

  async setCover(card: string, attachmentId: Uuid | null, options: CallOptions = {}): Promise<Card> {
    return this.ctx.http.patch<Card>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/cover`, { attachmentId }, options);
  }

  /** Comments and activity interleaved, newest first. */
  async history(
    card: string,
    options: { cursor?: string; limit?: number } & CallOptions = {},
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const { cursor, limit, ...call } = options;
    return this.ctx.http.get(`/api/v1/cards/${await this.ctx.resolveCard(card)}/feed`, { ...call, query: { cursor, limit } });
  }

  iterateHistory(card: string, options: { limit?: number } & CallOptions = {}): PageIterator<unknown> {
    return paginateCursor((cursor) => this.history(card, { ...options, cursor }));
  }

  /**
   * Checklist and comment content for many cards in one board, in one request. Best-effort: ids
   * that are not visible come back in `missingCardIds` rather than failing the whole call.
   */
  async content(
    boardId: Uuid,
    cards: string[],
    options: CallOptions = {},
  ): Promise<{ cards: unknown[]; missingCardIds: Uuid[]; truncatedCardIds: Uuid[] }> {
    const cardIds = await Promise.all(cards.map((card) => this.ctx.resolveCard(card)));
    return this.ctx.http.post(`/api/v1/boards/${boardId}/cards/content/query`, { cardIds }, options);
  }
}

export class CardAttachments {
  constructor(private readonly ctx: ResourceContext) {}

  async list(card: string, options: CallOptions = {}): Promise<Attachment[]> {
    return this.ctx.http.get<Attachment[]>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/attachments`, options);
  }

  async add(
    card: string,
    file: Blob | { bytes: Uint8Array; fileName: string; contentType?: string },
    options: CallOptions = {},
  ): Promise<Attachment> {
    return this.ctx.http.upload<Attachment>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/attachments`, file, options);
  }

  async delete(card: string, attachmentId: Uuid, options: CallOptions = {}): Promise<void> {
    return this.ctx.http.delete<void>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/attachments/${attachmentId}`, options);
  }
}

export class Checklists {
  constructor(private readonly ctx: ResourceContext) {}

  async create(card: string, body: { title: string; parentItemId?: Uuid | null }, options: CallOptions = {}): Promise<Checklist> {
    return this.ctx.http.post<Checklist>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/checklists`, body, options);
  }

  async update(card: string, checklistId: Uuid, body: { title: string }, options: CallOptions = {}): Promise<Checklist> {
    return this.ctx.http.patch<Checklist>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/checklists/${checklistId}`, body, options);
  }

  async delete(card: string, checklistId: Uuid, options: CallOptions = {}): Promise<void> {
    return this.ctx.http.delete<void>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/checklists/${checklistId}`, options);
  }

  async move(card: string, checklistId: Uuid, anchor: PositionAnchor, options: CallOptions = {}): Promise<Checklist> {
    return this.ctx.http.post<Checklist>(
      `/api/v1/cards/${await this.ctx.resolveCard(card)}/checklists/${checklistId}/move`,
      anchor.side === "after" ? { afterChecklistId: anchor.id } : { beforeChecklistId: anchor.id },
      options,
    );
  }

  async addItem(card: string, checklistId: Uuid, body: CreateChecklistItemInput, options: CallOptions = {}): Promise<ChecklistItem> {
    return this.ctx.http.post<ChecklistItem>(
      `/api/v1/cards/${await this.ctx.resolveCard(card)}/checklists/${checklistId}/items`,
      body,
      options,
    );
  }

  async updateItem(
    card: string,
    checklistId: Uuid,
    itemId: Uuid,
    body: UpdateChecklistItemInput,
    options: CallOptions = {},
  ): Promise<ChecklistItem> {
    return this.ctx.http.patch<ChecklistItem>(
      `/api/v1/cards/${await this.ctx.resolveCard(card)}/checklists/${checklistId}/items/${itemId}`,
      body,
      options,
    );
  }

  async deleteItem(card: string, checklistId: Uuid, itemId: Uuid, options: CallOptions = {}): Promise<void> {
    return this.ctx.http.delete<void>(
      `/api/v1/cards/${await this.ctx.resolveCard(card)}/checklists/${checklistId}/items/${itemId}`,
      options,
    );
  }

  async moveItem(
    card: string,
    checklistId: Uuid,
    itemId: Uuid,
    anchor: PositionAnchor,
    options: CallOptions = {},
  ): Promise<ChecklistItem> {
    return this.ctx.http.post<ChecklistItem>(
      `/api/v1/cards/${await this.ctx.resolveCard(card)}/checklists/${checklistId}/items/${itemId}/move`,
      anchor.side === "after" ? { afterItemId: anchor.id } : { beforeItemId: anchor.id },
      options,
    );
  }

  /** Update many items of one checklist in a single request. */
  async updateItems(
    card: string,
    checklistId: Uuid,
    body: { itemIds: Uuid[] } & UpdateChecklistItemInput,
    options: CallOptions = {},
  ): Promise<{ updated: number }> {
    return this.ctx.http.patch(
      `/api/v1/cards/${await this.ctx.resolveCard(card)}/checklists/${checklistId}/items/bulk`,
      body,
      options,
    );
  }
}

/**
 * Board-scoped batch mutations, capped at 200 cards per call. These exist because the alternative —
 * a request per card — is what makes migrations and cleanups hit rate limits.
 */
export class BulkCards {
  constructor(private readonly ctx: ResourceContext) {}

  private async selection(cards: string[]): Promise<{ cardIds: Uuid[] }> {
    return { cardIds: await Promise.all(cards.map((card) => this.ctx.resolveCard(card))) };
  }

  /** Archive only. The API takes `archived: true` and has no bulk unarchive. */
  async archive(boardId: Uuid, cards: string[], options: CallOptions = {}): Promise<BulkArchiveResult> {
    return this.ctx.http.patch(`/api/v1/boards/${boardId}/cards/bulk/archive`, { ...await this.selection(cards), archived: true }, options);
  }

  async setCompletion(boardId: Uuid, cards: string[], completed: boolean, options: CallOptions = {}): Promise<BulkCardResult> {
    return this.ctx.http.patch(`/api/v1/boards/${boardId}/cards/bulk/completion`, { ...await this.selection(cards), completed }, options);
  }

  async setDueDate(
    boardId: Uuid,
    cards: string[],
    body: { dueDateLocalDate: LocalDate | null; dueDateSlot?: DueDateSlot | null },
    options: CallOptions = {},
  ): Promise<BulkCardResult> {
    return this.ctx.http.patch(`/api/v1/boards/${boardId}/cards/bulk/due-date`, { ...await this.selection(cards), ...body }, options);
  }

  /** One direction per call: the API takes a `mode` plus the ids, not separate add/remove lists. */
  async patchLabels(
    boardId: Uuid,
    cards: string[],
    body: { mode: "add" | "remove"; labelIds: Uuid[] },
    options: CallOptions = {},
  ): Promise<BulkCardResult> {
    return this.ctx.http.patch(`/api/v1/boards/${boardId}/cards/bulk/labels`, { ...await this.selection(cards), ...body }, options);
  }

  async patchAssignees(
    boardId: Uuid,
    cards: string[],
    body: { mode: "add" | "remove"; userIds: Uuid[] },
    options: CallOptions = {},
  ): Promise<BulkCardResult> {
    return this.ctx.http.patch(`/api/v1/boards/${boardId}/cards/bulk/assignees`, { ...await this.selection(cards), ...body }, options);
  }

  async move(boardId: Uuid, cards: string[], body: { listId: Uuid }, options: CallOptions = {}): Promise<BulkCardResult> {
    return this.ctx.http.post(`/api/v1/boards/${boardId}/cards/bulk/move`, { ...await this.selection(cards), ...body }, options);
  }

  async duplicate(
    boardId: Uuid,
    cards: string[],
    body: { boardId?: Uuid; listId?: Uuid } = {},
    options: CallOptions = {},
  ): Promise<BulkCardResult> {
    return this.ctx.http.post(`/api/v1/boards/${boardId}/cards/bulk/duplicate`, { ...await this.selection(cards), ...body }, options);
  }

  /**
   * Set one custom field across the selection. `setAll`/`fillEmpty`/`clear` apply to scalar and
   * single-value fields; `add`/`remove` apply to multi-value select and user fields. The endpoint
   * rejects a mode the field's type does not support.
   */
  async setCustomField(
    boardId: Uuid,
    cards: string[],
    body: { fieldId: Uuid; mode: "setAll" | "fillEmpty" | "add" | "remove" | "clear" } & CustomFieldValueInput,
    options: CallOptions = {},
  ): Promise<BulkCardResult> {
    return this.ctx.http.patch(`/api/v1/boards/${boardId}/cards/bulk/custom-fields`, { ...await this.selection(cards), ...body }, options);
  }
}
