import { createCardReferenceResolver } from "./card-reference.js";
import { KaneraHttpClient, type KaneraClientOptions } from "./client.js";
import type { CallOptions, ResourceContext } from "./resources/base.js";
import { Boards, Lists } from "./resources/boards.js";
import { Cards } from "./resources/cards.js";
import { Comments } from "./resources/comments.js";
import { Notes } from "./resources/notes.js";
import { Search } from "./resources/search.js";
import { Work } from "./resources/work.js";
import { Automations, Workspaces } from "./resources/workspaces.js";
import type { Session } from "./types.js";

/**
 * The Kanera API client.
 *
 * ```ts
 * const kanera = new Kanera({ apiKey: process.env.KANERA_API_KEY! });
 *
 * const session = await kanera.session();
 * if (session.scope === "read") throw new Error("this credential cannot write");
 *
 * for await (const card of kanera.work.iterateCards()) console.log(card.key, card.title);
 * await kanera.cards.setCompletion("MKT-42", true);
 * ```
 *
 * Card arguments accept a UUID, a human key such as `MKT-42`, or a canonical card URL; keys are
 * resolved once per client and cached.
 */
export class Kanera {
  readonly http: KaneraHttpClient;
  readonly workspaces: Workspaces;
  readonly boards: Boards;
  readonly lists: Lists;
  readonly cards: Cards;
  readonly comments: Comments;
  readonly notes: Notes;
  readonly search: Search;
  readonly work: Work;
  readonly automations: Automations;

  constructor(options: KaneraClientOptions) {
    this.http = new KaneraHttpClient(options);
    const ctx: ResourceContext = {
      http: this.http,
      resolveCard: createCardReferenceResolver(this.http),
    };
    this.workspaces = new Workspaces(ctx);
    this.boards = new Boards(ctx);
    this.lists = new Lists(ctx);
    this.cards = new Cards(ctx);
    this.comments = new Comments(ctx);
    this.notes = new Notes(ctx);
    this.search = new Search(ctx);
    this.work = new Work(ctx);
    this.automations = new Automations(ctx);
  }

  /**
   * Describe the credential in use. Check `scope` once at start-up: a `read` credential refuses
   * every mutation, and finding that out here is cheaper than finding it out mid-migration.
   */
  session(options: CallOptions = {}): Promise<Session> {
    return this.http.get<Session>("/api/v1/session", options);
  }
}

export default Kanera;

export { KaneraHttpClient } from "./client.js";
export type { KaneraClientOptions, Query, QueryValue, RequestOptions } from "./client.js";
export { KaneraApiError, KaneraConnectionError, isKaneraApiError } from "./errors.js";
export {
  createCardReferenceResolver, isCardReference, parseCardUrl, resolveCardReference,
  type CanonicalCardReference,
} from "./card-reference.js";
export { paginateCursor, paginateOffset, type PageIterator } from "./pagination.js";
export type { CallOptions, ResourceContext } from "./resources/base.js";
export { Boards, Lists, type BoardDetail, type OpenBoardOptions } from "./resources/boards.js";
export {
  BulkCards, CardAttachments, Cards, Checklists,
  type CreateCardInput, type CreateChecklistItemInput, type CustomFieldValueInput, type MoveCardInput,
  type UpdateCardInput, type UpdateChecklistItemInput,
} from "./resources/cards.js";
export { Comments } from "./resources/comments.js";
export { Notes, type CreateNoteInput, type NoteTarget, type UpdateNoteInput } from "./resources/notes.js";
export { Search, type SearchInput } from "./resources/search.js";
export { Work, type WorkCardsInput, type WorkHistoryInput } from "./resources/work.js";
export { Automations, Workspaces, type Automation, type WorkspaceDetail } from "./resources/workspaces.js";
export * from "./types.js";
export {
  parseWebhook, verifyWebhookSignature, WebhookVerificationError,
  WEBHOOK_EVENT_ID_HEADER, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER,
  type ParseWebhookInput, type VerifyWebhookInput,
} from "./webhooks.js";
