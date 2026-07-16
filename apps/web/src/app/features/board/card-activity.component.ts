import type {
  ElementRef} from "@angular/core";
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import type { CardFeedPage, CommentReactionSummary, ReactionType, ReactionUserSummary } from "@kanera/shared/dto";
import { SERVER_EVENTS, type ActivityFeedEvent, type CardFeedItem, type CommentRow, type ServerToClientEvents, type WireBoardMemberUser } from "@kanera/shared/events";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { EditorDrafts } from "../../core/browser/editor-drafts";
import { UnsavedWorkService } from "../../core/browser/unsaved-work.service";
import { visibleSignedMediaUrl } from "../../core/media/signed-media-url";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { registerSocketHandlers } from "../../core/realtime/socket-handlers";
import { SocketService } from "../../core/realtime/socket.service";
import { attachmentIconClass } from "../../shared/attachment-icons";
import { AvatarComponent } from "../../shared/avatar.component";
import { DraftBannerComponent } from "../../shared/draft-banner.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { BoardState } from "./board-state";
import { DescriptionEditorComponent, type EditorSaveEvent } from "./description-editor.component";
import { descriptionDiff, hasDescriptionDiffPayload, type DescriptionDiff } from "./description-diff";
import { DescriptionViewerComponent } from "./description-viewer.component";
import { formatDueDate, type DueDateSlotSelection } from "./due-date.util";
import { ImageLightboxService } from "./image-lightbox.service";
import { ReactionPopoverComponent } from "./reaction-popover.component";

const CARD_FEED_PAGE_SIZE = 50;

type ActivityAttachmentPreview =
  | { kind: "image"; markdown: string; attachmentId: string }
  | { kind: "file"; fileName: string; iconClass: string; thumbnailUrl: string | null; url: string | null };

function cardFeedSortPriority(item: CardFeedItem): number {
  return item.type === "activity" && item.data.entityType === "card" && item.data.action === "created" ? 0 : 1;
}

// Precomputed render shape for a feed row. The activity-only fields (html, actorText, isSystem)
// and the relative time are pure functions of immutable item data, so deriving them once in a
// computed avoids re-running the ~170-line activityText switch / Date parsing for every row on
// every change detection pass (keystrokes, hovers, popover toggles).
type CardFeedView =
  | { kind: "comment"; key: string; data: CommentRow; timeText: string; isMirror: boolean }
  | {
      kind: "activity";
      key: string;
      data: ActivityFeedEvent;
      timeText: string;
      isSystem: boolean;
      isMirror: boolean;
      actorText: string | null;
      html: string;
      descriptionDiff: DescriptionDiff | null;
      attachmentPreview: ActivityAttachmentPreview | null;
    };

@Component({
  selector: "k-card-activity",
  standalone: true,
  imports: [
    AvatarComponent,
    DraftBannerComponent,
    DescriptionEditorComponent,
    DescriptionViewerComponent,
    ReactionPopoverComponent,
    TooltipDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./card-activity.component.html",
  styleUrl: "./card-activity.component.scss",
})
export class CardActivityComponent {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly editorDrafts = inject(EditorDrafts);
  private readonly unsavedWork = inject(UnsavedWorkService);
  private readonly unsavedDraftSource = Symbol("comment-draft");
  private readonly offlineCache = inject(OfflineCacheService);
  private readonly sockets = inject(SocketService);
  private readonly state = inject(BoardState);
  readonly imageLightbox = inject(ImageLightboxService);

  readonly cardId = input.required<string>();
  // Role-based permission only (connectivity-independent). Drives structural @if gating so the
  // composer/edit/reaction controls stay mounted across offline blips instead of flashing.
  readonly canEdit = input.required<boolean>();
  readonly members = input<WireBoardMemberUser[]>([]);
  readonly workspaceId = computed(() => this.state.board()?.workspaceId ?? null);

  // Live mutation gate: permission AND online. Used for handler guards and the disabled state of
  // send/edit/delete/reaction controls so they grey out (but stay mounted) when offline.
  readonly canMutate = computed(() => this.canEdit() && this.sockets.displayedOnline());

  readonly currentUserId = this.auth.user;
  readonly memberIds = computed(() => new Set(this.members().map((member) => member.userId)));
  readonly feedItems = signal<CardFeedItem[]>([]);
  // Feed load lifecycle. feedLoading gates a skeleton (only while we have no items yet) so the
  // initial fetch never flashes "No activity yet"; feedError drives an inline error + Retry.
  readonly feedLoading = signal(false);
  readonly feedError = signal(false);
  readonly feedNextCursor = signal<string | null>(null);
  readonly feedLoadingMore = signal(false);
  readonly feedHasMore = computed(() => this.feedNextCursor() !== null);
  readonly feedLoadMoreSentinel = viewChild<ElementRef<HTMLElement>>("feedLoadMoreSentinel");
  readonly feedFilter = signal<"all" | "comments">("all");
  readonly commentSearchQuery = signal("");
  readonly commentSearchOpen = signal(false);
  readonly selectedDescriptionDiffId = signal<string | null>(null);
  readonly selectedDescriptionDiff = computed(() => {
    const id = this.selectedDescriptionDiffId();
    if (!id) return null;
    for (const item of this.feedItems()) {
      if (item.type !== "activity" || item.data.id !== id) continue;
      const diff = this.descriptionDiffForActivity(item.data);
      return diff ? { activity: item.data, diff } : null;
    }
    return null;
  });
  readonly filteredFeedItems = computed(() => {
    const q = this.commentSearchQuery().trim().toLowerCase();
    // Hide aggregate rows left by older mirror workers; the rich source activities are the audit
    // trail and make an unexplained "N mirrored changes" entry redundant and misleading.
    const renderableItems = this.feedItems().filter((item) => item.type !== "activity" || item.data.coalesceKey !== "card:mirrorSync");
    const visibleItems = this.feedFilter() === "comments"
      ? renderableItems.filter((item) => item.type === "comment")
      : renderableItems;
    if (!q) return visibleItems;
    return visibleItems.filter((item) => item.type === "comment" && item.data.body.toLowerCase().includes(q));
  });
  // Render view-model: derives the static-per-item activity fields and relative time once per
  // feed change instead of per change detection. Recomputes when the feed, filter, or (for the
  // "moved" activity case) state.lists() change. timeText intentionally does not refresh on a
  // timer — it re-derives whenever the feed signal changes, which is acceptable for relative ages.
  readonly feedViewItems = computed<CardFeedView[]>(() =>
    this.filteredFeedItems().map((item) => {
      const timeText = this.formatFeedTime(item.data.createdAt);
      if (item.type === "comment") {
        return { kind: "comment", key: item.data.id, data: item.data, timeText, isMirror: typeof item.data.mirrorId === "string" };
      }
      return {
        kind: "activity",
        key: item.data.id,
        data: item.data,
        timeText,
        isSystem: this.isSystemActivity(item.data),
        isMirror: typeof (item.data.payload as Record<string, unknown>)["mirrorId"] === "string",
        actorText: this.activityActorText(item.data),
        html: this.activityText(item.data),
        descriptionDiff: this.descriptionDiffForActivity(item.data),
        attachmentPreview: this.attachmentPreviewForActivity(item.data),
      };
    }),
  );

  showAuthorPresence(authorKind: string, authorId: string | null): boolean {
    return authorKind === "user" && Boolean(authorId && this.memberIds().has(authorId));
  }

  copiedSystemAuthorName(comment: CommentRow): string | null {
    return comment.authorKind === "system" && comment.apiKeyName ? comment.apiKeyName : null;
  }
  readonly submittingComment = signal(false);
  readonly addingComment = signal(false);
  // Initial markdown for the new-comment editor. Empty for a fresh comment; a
  // quoted blockquote when starting a reply. The editor reads this only at
  // creation, which is why opening a reply (re)creates it via addingComment.
  readonly newCommentInitialValue = signal("");
  readonly recoveredNewCommentDraft = signal(false);
  readonly editingCommentId = signal<string | null>(null);
  readonly editCommentBody = signal("");
  readonly editCommentBaseBody = signal("");
  readonly savedEditCommentDraftId = signal<string | null>(null);
  readonly recoveredEditCommentDraft = signal(false);
  readonly reactionPopoverAnchor = signal<HTMLElement | null>(null);
  readonly reactionPopoverUsers = signal<ReactionUserSummary[]>([]);

  private readonly newCommentEditor = viewChild<DescriptionEditorComponent>("newCommentEditor");
  private readonly editCommentEditor = viewChild<DescriptionEditorComponent>("editCommentEditor");
  private feedLoadSeq = 0;
  // Bumped by the realtime handlers whenever a socket event mutates the current card's feed.
  // refreshFeedFromNetwork snapshots this before its request and union-merges (instead of blindly
  // replacing) if it advanced mid-flight, so a comment/reaction that arrives during the fetch is
  // not clobbered by a slightly-stale server page. See CLAUDE.md on realtime-fanout ordering.
  private feedRealtimeVersion = 0;
  // Keys ("type:id") of feed items deleted via realtime for the current card. A server page that was
  // built before the delete (a stale first-page refresh or an older pagination page) still contains
  // the item; without a tombstone, mergeFeedPage would resurrect it. Cleared on card change and
  // whenever an upsert re-establishes the item as present.
  private readonly feedTombstones = new Set<string>();
  // Reaction events can arrive before the initial feed page containing their comment. Preserve
  // those ordered operations until that comment is hydrated instead of silently dropping them.
  private readonly pendingReactionOperations = new Map<string, Array<
    | { kind: "add"; type: ReactionType; user: ReactionUserSummary }
    | { kind: "remove"; type: ReactionType; userId: string }
  >>();

  constructor() {
    effect((onCleanup) => {
      const hasDraft = this.recoveredNewCommentDraft() || this.recoveredEditCommentDraft();
      this.unsavedWork.setDirty(this.unsavedDraftSource, hasDraft);
      onCleanup(() => this.unsavedWork.setDirty(this.unsavedDraftSource, false));
    });
    effect((onCleanup) => {
      const cardId = this.cardId();

      this.editingCommentId.set(null);
      this.addingComment.set(false);
      this.recoveredNewCommentDraft.set(false);
      this.recoveredEditCommentDraft.set(false);
      this.savedEditCommentDraftId.set(null);
      this.feedItems.set([]);
      this.feedTombstones.clear();
      this.pendingReactionOperations.clear();
      // Enter the loading state as we clear the feed so there is no "No activity yet" flash
      // between the reset here and the fetch kicked off by the network effect below.
      this.feedLoading.set(true);
      this.feedError.set(false);
      this.feedNextCursor.set(null);
      this.feedLoadingMore.set(false);
      this.feedFilter.set("all");
      this.commentSearchQuery.set("");
      this.commentSearchOpen.set(false);
      this.selectedDescriptionDiffId.set(null);
      // Keep this initializer scoped to card changes. Auth refreshes replace the
      // user object even when the user id is unchanged, and connectivity changes
      // can toggle canMutate; neither should clear an already-loaded feed.
      const { currentUserId, canMutateNow } = untracked(() => ({
        currentUserId: this.currentUserId()?.id,
        canMutateNow: this.canMutate(),
      }));
      const recovered = this.editorDrafts.load(currentUserId, "comment-new", cardId);
      if (recovered) {
        this.newCommentInitialValue.set(recovered.markdown);
        this.addingComment.set(canMutateNow);
        this.recoveredNewCommentDraft.set(true);
      } else {
        this.newCommentInitialValue.set("");
      }

      const socket = this.sockets.connect();
      const handlers: Partial<ServerToClientEvents> = {
        [SERVER_EVENTS.CARD_FEED_ITEM_CREATED]: ({ cardId: cid, item }) => {
          if (cid !== cardId) return;
          this.feedRealtimeVersion++;
          const next = this.upsertFeedItem(this.feedItems(), item);
          this.feedItems.set(next);
          this.persistFeedSnapshot(cardId, next);
        },
        [SERVER_EVENTS.CARD_FEED_ITEM_UPDATED]: ({ cardId: cid, item }) => {
          if (cid !== cardId) return;
          this.feedRealtimeVersion++;
          const next = this.upsertFeedItem(this.feedItems(), item);
          this.feedItems.set(next);
          this.persistFeedSnapshot(cardId, next);
        },
        [SERVER_EVENTS.CARD_FEED_ITEM_DELETED]: ({ cardId: cid, type, itemId }) => {
          if (cid !== cardId) return;
          this.feedRealtimeVersion++;
          // Tombstone the key so a stale server page can't reintroduce the just-deleted item.
          this.feedTombstones.add(`${type}:${itemId}`);
          if (type === "comment") this.pendingReactionOperations.delete(itemId);
          const next = this.feedItems().filter((item) => item.type !== type || item.data.id !== itemId);
          this.feedItems.set(next);
          this.persistFeedSnapshot(cardId, next);
        },
        [SERVER_EVENTS.COMMENT_REACTION_ADDED]: ({ cardId: cid, commentId, type, user }) => {
          if (cid !== cardId) return;
          this.feedRealtimeVersion++;
          const current = this.feedItems();
          if (!this.hasComment(current, commentId)) {
            this.queueReactionOperation(commentId, { kind: "add", type, user });
          }
          const next = this.applyReactionAdded(current, commentId, type, user);
          this.feedItems.set(next);
          this.persistFeedSnapshot(cardId, next);
        },
        [SERVER_EVENTS.COMMENT_REACTION_REMOVED]: ({ cardId: cid, commentId, type, userId }) => {
          if (cid !== cardId) return;
          this.feedRealtimeVersion++;
          const current = this.feedItems();
          if (!this.hasComment(current, commentId)) {
            this.queueReactionOperation(commentId, { kind: "remove", type, userId });
          }
          const next = this.applyReactionRemoved(current, commentId, type, userId);
          this.feedItems.set(next);
          this.persistFeedSnapshot(cardId, next);
        },
      };

      onCleanup(registerSocketHandlers(socket, handlers));
    });

    effect(() => {
      const cardId = this.cardId();
      if (this.sockets.displayedOnline()) {
        void this.refreshFeedFromNetwork(cardId);
      } else {
        void this.loadCachedFeed(cardId);
      }
    });

    effect(() => {
      if (this.canMutate()) return;
      if (this.addingComment()) this.preserveAndCloseNewCommentDraft();
      if (this.editingCommentId()) this.preserveAndCloseEditCommentDraft();
    });

    effect(() => {
      if (!this.canMutate() || this.editingCommentId()) return;
      this.restoreEditCommentDraft();
    });

    effect((onCleanup) => {
      const sentinel = this.feedLoadMoreSentinel()?.nativeElement;
      if (!sentinel || typeof IntersectionObserver === "undefined") return;

      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) void this.loadMoreFeed();
        },
        { root: null, rootMargin: "160px 0px 160px 0px" },
      );
      observer.observe(sentinel);
      onCleanup(() => observer.disconnect());
    });
  }

  private async refreshFeedFromNetwork(cardId: string) {
    const seq = ++this.feedLoadSeq;
    // Snapshot the realtime version before the request so we can tell whether a socket event
    // touched this card's feed while the fetch was in flight (see feedRealtimeVersion).
    const realtimeVersion = this.feedRealtimeVersion;
    try {
      const page = await this.api.get<CardFeedPage>(`/cards/${cardId}/feed?limit=${CARD_FEED_PAGE_SIZE}`);
      if (seq !== this.feedLoadSeq) return;
      // Realtime-vs-network ordering: if no realtime event landed during the request the server
      // page is authoritative and we replace; if one did, union-merge so a just-received
      // comment/reaction isn't clobbered by the slightly-stale page.
      const next = this.feedRealtimeVersion === realtimeVersion
        ? page.items
        : this.mergeFeedPage(this.feedItems(), page.items);
      this.feedItems.set(next);
      this.feedNextCursor.set(page.nextCursor);
      this.persistFeedSnapshot(cardId, next);
      this.feedError.set(false);
      this.feedLoading.set(false);
    } catch {
      // loadCachedFeed bumps feedLoadSeq and finalizes loading/error itself, so guard on the
      // original seq before delegating and don't double-finalize here.
      if (seq === this.feedLoadSeq) await this.loadCachedFeed(cardId);
    }
  }

  private async loadCachedFeed(cardId: string) {
    const seq = ++this.feedLoadSeq;
    let recovered = false;
    try {
      const cached = await this.offlineCache.loadCardDetail(cardId).catch(() => null);
      if (seq !== this.feedLoadSeq) return;
      if (cached) {
        // A cache hit is a successful recovery even when its feed is empty (the card genuinely has
        // no activity) — track that separately from row count so the empty state isn't shown as an error.
        recovered = true;
        this.state.setCardDetail(cached.detail);
        // During a live disconnect, the in-memory feed is the freshest offline snapshot.
        // Detail-only cache writes can contain an empty feed, so do not let them blank
        // activity/comments that are already visible.
        if (cached.feed.length > 0 || this.feedItems().length === 0) {
          this.feedItems.set(cached.feed);
        }
        this.feedNextCursor.set(null);
      }
    } finally {
      if (seq === this.feedLoadSeq) {
        this.feedLoading.set(false);
        // Error only when nothing recovered the feed (no cache, no in-memory rows). A recovered but
        // empty cache is a legitimate "No activity yet", not a "Couldn't load activity" failure.
        this.feedError.set(!recovered && this.feedItems().length === 0);
      }
    }
  }

  retryFeed() {
    void this.refreshFeedFromNetwork(this.cardId());
  }

  @HostListener("document:click", ["$event"])
  onDocumentClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (!target?.closest(".comment-search-wrap")) this.commentSearchOpen.set(false);
  }

  @HostListener("document:keydown.escape")
  onEscape() {
    this.closeDescriptionDiff();
  }

  toggleCommentSearch(event: MouseEvent) {
    event.stopPropagation();
    this.commentSearchOpen.update((open) => !open);
  }

  openDescriptionDiff(activityId: string) {
    this.selectedDescriptionDiffId.set(activityId);
  }

  closeDescriptionDiff() {
    this.selectedDescriptionDiffId.set(null);
  }

  startAddComment() {
    if (!this.canMutate()) return;
    const recovered = this.editorDrafts.load(this.currentUserId()?.id, "comment-new", this.cardId());
    this.newCommentInitialValue.set(recovered?.markdown ?? "");
    this.recoveredNewCommentDraft.set(Boolean(recovered));
    this.addingComment.set(true);
  }

  cancelAddComment() {
    this.discardNewCommentDraft();
  }

  onNewCommentDraftChange(markdown: string) {
    this.editorDrafts.save({
      userId: this.currentUserId()?.id,
      kind: "comment-new",
      entityId: this.cardId(),
      cardId: this.cardId(),
      markdown,
      baseMarkdown: "",
    });
  }

  discardNewCommentDraft() {
    this.editorDrafts.clear(this.currentUserId()?.id, "comment-new", this.cardId());
    this.newCommentEditor()?.reset();
    this.newCommentInitialValue.set("");
    this.recoveredNewCommentDraft.set(false);
    this.addingComment.set(false);
  }

  private preserveAndCloseNewCommentDraft() {
    const existingDraft = this.editorDrafts.load(this.currentUserId()?.id, "comment-new", this.cardId());
    const editorMarkdown = this.newCommentEditor()?.markdown();
    const markdown = editorMarkdown?.trim() ? editorMarkdown : existingDraft?.markdown ?? editorMarkdown ?? "";
    const draft = this.editorDrafts.save({
      userId: this.currentUserId()?.id,
      kind: "comment-new",
      entityId: this.cardId(),
      cardId: this.cardId(),
      markdown,
      baseMarkdown: "",
    });
    this.newCommentInitialValue.set(draft?.markdown ?? markdown);
    this.recoveredNewCommentDraft.set(Boolean(draft));
    this.newCommentEditor()?.setSaving(false);
    this.addingComment.set(false);
  }

  private buildReplyQuote(comment: CommentRow): string {
    // @mention user authors so they get notified; api/bot authors have no user
    // id to mention, so fall back to a bold name.
    const attribution = comment.authorKind === "user"
      ? `@[${comment.authorName}](kanera-user:${comment.authorId}) wrote:`
      : `**${comment.authorName} wrote:**`;
    const quotedBody = comment.body
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    // Attribution line, the quoted body, then a blank line for the reply.
    return `> ${attribution}\n>\n${quotedBody}\n\n`;
  }

  startReplyComment(comment: CommentRow) {
    if (!this.canMutate()) return;
    const quote = this.buildReplyQuote(comment);
    if (this.addingComment()) {
      // Composer already open with a draft — prepend the quote, keep the draft.
      this.newCommentEditor()?.prependMarkdown(quote);
    } else {
      this.newCommentInitialValue.set(quote);
      this.addingComment.set(true);
    }
  }

  async submitComment(event: EditorSaveEvent) {
    const body = event.markdown.trim();
    if (!body) {
      this.newCommentEditor()?.setSaving(false);
      return;
    }
    if (!this.canMutate()) {
      const draft = this.editorDrafts.save({
        userId: this.currentUserId()?.id,
        kind: "comment-new",
        entityId: this.cardId(),
        cardId: this.cardId(),
        markdown: event.markdown,
        baseMarkdown: "",
      });
      this.newCommentInitialValue.set(draft?.markdown ?? event.markdown);
      this.recoveredNewCommentDraft.set(Boolean(draft));
      this.addingComment.set(false);
      this.newCommentEditor()?.setSaving(false);
      return;
    }
    this.submittingComment.set(true);
    try {
      const comment = await this.api.post<CommentRow>(`/cards/${this.cardId()}/comments`, {
        body,
        attachmentIds: event.attachmentIds,
      });
      const next = this.upsertFeedItem(this.feedItems(), { type: "comment", data: comment });
      this.feedItems.set(next);
      this.persistFeedSnapshot(this.cardId(), next);
      this.editorDrafts.clear(this.currentUserId()?.id, "comment-new", this.cardId());
      this.newCommentEditor()?.reset();
      this.newCommentInitialValue.set("");
      this.recoveredNewCommentDraft.set(false);
      this.addingComment.set(false);
    } finally {
      this.submittingComment.set(false);
      this.newCommentEditor()?.setSaving(false);
    }
  }

  startEditComment(comment: CommentRow) {
    if (!this.canMutate()) return;
    const recovered = this.editorDrafts.load(this.currentUserId()?.id, "comment-edit", comment.id);
    this.editingCommentId.set(comment.id);
    this.savedEditCommentDraftId.set(null);
    this.editCommentBaseBody.set(comment.body);
    this.editCommentBody.set(recovered?.markdown ?? comment.body);
    this.recoveredEditCommentDraft.set(Boolean(recovered));
  }

  cancelEditComment() {
    this.discardEditCommentDraft();
  }

  onEditCommentDraftChange(comment: CommentRow, markdown: string) {
    this.editorDrafts.save({
      userId: this.currentUserId()?.id,
      kind: "comment-edit",
      entityId: comment.id,
      cardId: this.cardId(),
      commentId: comment.id,
      markdown,
      baseMarkdown: this.editCommentBaseBody() || comment.body,
    });
  }

  discardEditCommentDraft() {
    const id = this.editingCommentId();
    if (id) this.editorDrafts.clear(this.currentUserId()?.id, "comment-edit", id);
    this.editingCommentId.set(null);
    this.editCommentBody.set("");
    this.editCommentBaseBody.set("");
    this.savedEditCommentDraftId.set(null);
    this.recoveredEditCommentDraft.set(false);
  }

  private preserveAndCloseEditCommentDraft() {
    const id = this.editingCommentId();
    if (!id) return;
    const baseMarkdown = this.editCommentBaseBody() || this.findCommentBody(id);
    const existingDraft = this.editorDrafts.load(this.currentUserId()?.id, "comment-edit", id);
    const editorMarkdown = this.editCommentEditor()?.markdown();
    const markdown = editorMarkdown?.trim() === baseMarkdown.trim()
      ? existingDraft?.markdown ?? editorMarkdown
      : editorMarkdown;
    const draft = this.editorDrafts.save({
      userId: this.currentUserId()?.id,
      kind: "comment-edit",
      entityId: id,
      cardId: this.cardId(),
      commentId: id,
      markdown: markdown ?? existingDraft?.markdown ?? this.editCommentBody(),
      baseMarkdown,
    });
    this.editCommentBody.set(draft?.markdown ?? this.editCommentBody());
    this.savedEditCommentDraftId.set(id);
    this.recoveredEditCommentDraft.set(Boolean(draft));
    this.editingCommentId.set(null);
    this.editCommentBaseBody.set("");
    this.editCommentEditor()?.setSaving(false);
  }

  async saveEditComment(id: string, event: EditorSaveEvent) {
    const body = event.markdown.trim();
    if (!body) {
      this.editCommentEditor()?.setSaving(false);
      return;
    }
    if (!this.canMutate()) {
      const baseMarkdown = this.editCommentBaseBody() || this.findCommentBody(id);
      const draft = this.editorDrafts.save({
        userId: this.currentUserId()?.id,
        kind: "comment-edit",
        entityId: id,
        cardId: this.cardId(),
        commentId: id,
        markdown: event.markdown,
        baseMarkdown,
      });
      this.editCommentBody.set(draft?.markdown ?? event.markdown);
      this.savedEditCommentDraftId.set(id);
      this.recoveredEditCommentDraft.set(Boolean(draft));
      this.editingCommentId.set(null);
      this.editCommentBaseBody.set("");
      this.editCommentEditor()?.setSaving(false);
      return;
    }
    try {
      const comment = await this.api.patch<CommentRow>(`/comments/${id}`, {
        body,
        attachmentIds: event.attachmentIds,
      });
      const next = this.upsertFeedItem(this.feedItems(), { type: "comment", data: comment });
      this.feedItems.set(next);
      this.persistFeedSnapshot(this.cardId(), next);
      this.editorDrafts.clear(this.currentUserId()?.id, "comment-edit", id);
      this.editingCommentId.set(null);
      this.editCommentBody.set("");
      this.editCommentBaseBody.set("");
      this.savedEditCommentDraftId.set(null);
      this.recoveredEditCommentDraft.set(false);
    } finally {
      this.editCommentEditor()?.setSaving(false);
    }
  }

  private restoreEditCommentDraft() {
    const userId = this.currentUserId()?.id;
    if (!userId) return;
    for (const item of this.feedItems()) {
      if (item.type !== "comment") continue;
      const draft = this.editorDrafts.load(userId, "comment-edit", item.data.id);
      if (!draft) continue;
      this.editingCommentId.set(item.data.id);
      this.savedEditCommentDraftId.set(null);
      this.editCommentBaseBody.set(item.data.body);
      this.editCommentBody.set(draft.markdown);
      this.recoveredEditCommentDraft.set(true);
      return;
    }
  }

  private findCommentBody(commentId: string): string {
    const item = this.feedItems().find((feedItem) => feedItem.type === "comment" && feedItem.data.id === commentId);
    return item?.type === "comment" ? item.data.body : "";
  }

  async deleteComment(id: string) {
    if (!this.canMutate()) return;
    await this.api.delete(`/comments/${id}`);
    const next = this.feedItems().filter((item) => item.type !== "comment" || item.data.id !== id);
    this.feedItems.set(next);
    this.persistFeedSnapshot(this.cardId(), next);
  }

  async loadMoreFeed() {
    const cursor = this.feedNextCursor();
    if (!cursor || this.feedLoadingMore()) return;
    // Capture the card id and load sequence up front: if the open card switches (or the feed is
    // reloaded) mid-request, this page belongs to the previous card and must not merge into the new one.
    const cardId = this.cardId();
    const seq = this.feedLoadSeq;
    this.feedLoadingMore.set(true);
    try {
      const page = await this.api.get<CardFeedPage>(
        `/cards/${cardId}/feed?limit=${CARD_FEED_PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`,
      );
      if (seq !== this.feedLoadSeq) return;
      const next = this.mergeFeedPage(this.feedItems(), page.items);
      this.feedItems.set(next);
      this.feedNextCursor.set(page.nextCursor);
      this.persistFeedSnapshot(cardId, next);
    } finally {
      // Only release the guard for the request we started. If the card switched mid-flight, the new
      // card owns feedLoadingMore now — clearing it here would unlock its loader and allow a duplicate
      // pagination request.
      if (seq === this.feedLoadSeq) this.feedLoadingMore.set(false);
    }
  }

  descriptionDiffForActivity(event: ActivityFeedEvent): DescriptionDiff | null {
    if (event.entityType !== "card" || event.action !== "updated") return null;
    const payload = event.payload as Record<string, unknown>;
    if (!("description" in payload) || !hasDescriptionDiffPayload(payload)) return null;
    const fromValue = payload["fromValue"];
    const hadPriorDescription = typeof fromValue === "string" && fromValue.trim().length > 0;
    // First-capture activity is already clear from "updated the description"; the
    // diff modal would only show all-added text and adds noise to the feed.
    if (!hadPriorDescription) return null;
    const diff = descriptionDiff(payload["fromValue"], payload["toValue"]);
    // Show the diff for real text changes, and also for formatting/link/image-only
    // edits (lines empty) so the modal can acknowledge them with a note rather than
    // leaving "updated the description" unexplained.
    return diff.hasChanges || diff.formattingOnly ? diff : null;
  }

  attachmentPreviewForActivity(event: ActivityFeedEvent): ActivityAttachmentPreview | null {
    if (event.entityType !== "card" || event.action !== "attachment_added") return null;
    const payload = event.payload as Record<string, unknown>;
    if (typeof payload["attachmentId"] !== "string") return null;
    const attachmentId = payload["attachmentId"];
    // Activity rows are durable history and only store attachment metadata; the
    // live detail attachment row carries the current signed media URL.
    const attachment = this.state.coverAttachmentById().get(attachmentId);
    const mimeType = attachment?.mimeType ?? (typeof payload["mimeType"] === "string" ? payload["mimeType"] : "");
    const fileName = attachment?.fileName ?? (typeof payload["fileName"] === "string" ? payload["fileName"] : "attachment");
    if (mimeType.startsWith("image/")) {
      const src = visibleSignedMediaUrl(attachment?.url);
      if (!src) return null;
      return {
        kind: "image",
        attachmentId,
        markdown: `![${this.markdownAltText(fileName)}](${src})`,
      };
    }
    return {
      kind: "file",
      fileName,
      iconClass: attachmentIconClass(mimeType, fileName),
      thumbnailUrl: visibleSignedMediaUrl(attachment?.thumbnailUrl),
      url: visibleSignedMediaUrl(attachment?.url),
    };
  }

  openActivityAttachmentImage(attachmentId: string, event?: Event) {
    const attachment = this.state.coverAttachmentById().get(attachmentId);
    const src = visibleSignedMediaUrl(attachment?.url);
    if (!src) return;
    this.imageLightbox.open({ src, fileName: attachment?.fileName, createdAt: attachment?.createdAt }, event);
  }

  activityText(event: ActivityFeedEvent): string {
    const p = event.payload as Record<string, unknown>;
    switch (event.action) {
      case "created": {
        const sourceBoardName = this.activityPayloadText(p, "duplicatedFromBoardName");
        if (sourceBoardName) return ` copied this card from ${this.v(sourceBoardName)}`;
        if (typeof p["duplicatedFromBoardId"] === "string") return ` copied this card from ${this.v(p["duplicatedFromBoardId"])}`;
        if (typeof p["duplicatedFromId"] === "string") return " copied this card from another board";
        if (typeof p["importedFrom"] === "string") return " imported this card";
        return " created this card";
      }
      case "updated": {
        const title = p["title"];
        if (typeof title === "string") return ` renamed this card to ${this.v(title)}`;
        if ("description" in p) {
          return event.coalescedCount > 1
            ? ` updated the description ${event.coalescedCount} times`
            : " updated the description";
        }
        if ("dueDateLocalDate" in p) {
          return p["dueDateLocalDate"]
            ? ` set the due date to ${this.v(formatDueDate(p["dueDateLocalDate"] as string | null | undefined, p["dueDateSlot"] as DueDateSlotSelection | null | undefined, p["dueDateTimezone"] as string | null | undefined))}`
            : " cleared the due date";
        }
        return " updated this card";
      }
      case "moved": {
        const lists = this.state.lists();
        const toName = lists.find((l) => l.id === p["toListId"])?.name ?? this.activityPayloadText(p, "toListName");
        const fromName = lists.find((l) => l.id === p["fromListId"])?.name ?? this.activityPayloadText(p, "fromListName");
        if (toName && fromName) return ` moved from ${this.v(fromName)} ${this.arr()} ${this.v(toName)}`;
        if (toName) return ` moved to ${this.v(toName)}`;
        return " moved this card";
      }
      case "completed":
        return " marked this card complete";
      case "uncompleted":
        return " marked this card incomplete";
      case "completion:set":
        if (event.coalescedCount > 1) {
          return p["toValue"] === true
            ? ` toggled this card complete ${event.coalescedCount} times; left it complete`
            : ` toggled this card complete ${event.coalescedCount} times; left it incomplete`;
        }
        return p["toValue"] === true ? " marked this card complete" : " marked this card incomplete";
      case "overdue":
        return `This card is marked as ${this.v("overdue", "overdue")}`;
      case "deleted":
        return " deleted this card";
      case "labels:set": {
        const addedNames = this.activityPayloadNames(p, "addedLabelNames");
        if (addedNames.length > 0) return ` added label${addedNames.length === 1 ? "" : "s"} ${this.activityNameList(addedNames)}`;

        const removedNames = this.activityPayloadNames(p, "removedLabelNames");
        if (removedNames.length > 0) return ` removed label${removedNames.length === 1 ? "" : "s"} ${this.activityNameList(removedNames)}`;

        const names = this.activityPayloadNames(p, "labelNames");
        if (names.length === 0 && Array.isArray(p["labelIds"]) && p["labelIds"].length === 0) return " cleared all labels";
        return " updated the labels";
      }
      case "assignees:set": {
        const netNames = this.activityNetAssigneeNames(p);
        const addedNames = netNames.added.length ? netNames.added : this.activityPayloadNames(p, "addedAssigneeNames");
        const removedNames = netNames.removed.length ? netNames.removed : this.activityPayloadNames(p, "removedAssigneeNames");
        const parts: string[] = [];
        if (addedNames.length > 0) {
          parts.push(this.activityAddedSelf(p, event)
            ? "assigned themself"
            : `assigned ${this.activityNameList(addedNames)}`);
        }
        if (removedNames.length > 0) parts.push(`unassigned ${this.activityNameList(removedNames)}`);
        if (parts.length > 0) return ` ${parts.join(" and ")}`;

        const ids = p["assigneeIds"] as string[] | undefined;
        return ids?.length ? " updated the assignees" : " removed all assignees";
      }
      case "customFieldValue:set": {
        const fieldName = this.activityFieldName(p);
        const from = this.vField(p["fromValue"]);
        const to = this.vField(p["toValue"]);
        if (event.coalescedCount > 1) {
          return ` changed ${this.v(fieldName)} ${event.coalescedCount} times: ${from ?? "empty"} ${this.arr()} ${to ?? "empty"}`;
        }
        if (!from) return ` set ${this.v(fieldName)} to ${to ?? "empty"}`;
        return ` changed ${this.v(fieldName)}: ${from} ${this.arr()} ${to ?? "empty"}`;
      }
      case "customFieldValue:cleared": {
        const fieldName = this.activityFieldName(p);
        const from = this.vField(p["fromValue"]);
        return from
          ? ` cleared ${this.v(fieldName)} (was ${from})`
          : ` cleared ${this.v(fieldName)}`;
      }
      case "checklist:created":
        return this.activityPayloadText(p, "title")
          ? ` added checklist ${this.v(this.activityPayloadText(p, "title")!)}`
          : " added a checklist";
      case "checklist:deleted":
        return this.activityPayloadText(p, "title")
          ? ` deleted checklist ${this.v(this.activityPayloadText(p, "title")!)}`
          : " deleted a checklist";
      case "checklist:completed": {
        const title = this.activityPayloadText(p, "title");
        const parentItemText = this.activityPayloadText(p, "parentItemText");
        if (parentItemText) {
          return title
            ? ` completed sub-checklist ${this.v(title)} on ${this.v(parentItemText)}`
            : ` completed a sub-checklist on ${this.v(parentItemText)}`;
        }
        return title ? ` completed checklist ${this.v(title)}` : " completed a checklist";
      }
      case "checklist:renamed": {
        const from = this.vField(p["fromValue"]);
        const to = this.vField(p["toValue"]);
        if (event.coalescedCount > 1) return ` renamed a checklist ${event.coalescedCount} times: ${from ?? "empty"} ${this.arr()} ${to ?? "empty"}`;
        return ` renamed a checklist: ${from ?? "empty"} ${this.arr()} ${to ?? "empty"}`;
      }
      case "checklistItem:created":
        return this.activityPayloadText(p, "text")
          ? ` added checklist item ${this.v(this.activityPayloadText(p, "text")!)}`
          : " added a checklist item";
      case "checklistItem:deleted":
        return this.activityPayloadText(p, "text")
          ? ` deleted checklist item ${this.v(this.activityPayloadText(p, "text")!)}`
          : " deleted a checklist item";
      case "checklistItem:updated": {
        const from = this.vField(p["fromValue"]);
        const to = this.vField(p["toValue"]);
        if (event.coalescedCount > 1) return ` edited a checklist item ${event.coalescedCount} times: ${from ?? "empty"} ${this.arr()} ${to ?? "empty"}`;
        return ` edited a checklist item: ${from ?? "empty"} ${this.arr()} ${to ?? "empty"}`;
      }
      case "checklistItem:description:set": {
        const itemText = this.activityPayloadText(p, "itemText");
        const suffix = itemText ? ` for ${this.v(itemText)}` : "";
        return p["toValue"] ? ` updated the checklist item description${suffix}` : ` cleared the checklist item description${suffix}`;
      }
      case "checklistItem:assignee:set": {
        if (p["bulk"] === true) {
          const count = typeof p["itemCount"] === "number" ? p["itemCount"] : 0;
          const itemLabel = count === 1 ? "checklist item" : "checklist items";
          const assigneeName = this.activityPayloadText(p, "assigneeName");
          const checklistTitle = this.activityPayloadText(p, "checklistTitle");
          const checklistSuffix = checklistTitle ? ` in ${this.v(checklistTitle)}` : "";
          return assigneeName
            ? ` assigned ${this.v(assigneeName)} to ${count} ${itemLabel}${checklistSuffix}`
            : ` unassigned ${count} ${itemLabel}${checklistSuffix}`;
        }
        const itemText = this.activityPayloadText(p, "itemText");
        const assigneeName = this.activityPayloadText(p, "assigneeName");
        const previousAssigneeName = this.activityPayloadText(p, "previousAssigneeName");
        const itemSuffix = itemText ? ` ${this.v(itemText)}` : "";
        if (assigneeName && previousAssigneeName) {
          return ` changed checklist item${itemSuffix} assignee from ${this.v(previousAssigneeName)} to ${this.v(assigneeName)}`;
        }
        if (assigneeName) return ` assigned ${this.v(assigneeName)} to checklist item${itemSuffix}`;
        if (previousAssigneeName) return ` removed ${this.v(previousAssigneeName)} from checklist item${itemSuffix}`;
        return ` updated checklist item assignee${itemSuffix}`;
      }
      case "checklistItem:dueDate:set": {
        if (p["bulk"] === true) {
          const count = typeof p["itemCount"] === "number" ? p["itemCount"] : 0;
          const itemLabel = count === 1 ? "checklist item" : "checklist items";
          const checklistTitle = this.activityPayloadText(p, "checklistTitle");
          const checklistSuffix = checklistTitle ? ` in ${this.v(checklistTitle)}` : "";
          return p["dueDateLocalDate"]
            ? ` set the due date on ${count} ${itemLabel}${checklistSuffix} to ${this.v(formatDueDate(p["dueDateLocalDate"] as string | null | undefined, p["dueDateSlot"] as DueDateSlotSelection | null | undefined, p["dueDateTimezone"] as string | null | undefined))}`
            : ` cleared the due date on ${count} ${itemLabel}${checklistSuffix}`;
        }
        const itemText = this.activityPayloadText(p, "itemText");
        const itemSuffix = itemText ? ` ${this.v(itemText)}` : "";
        return p["dueDateLocalDate"]
          ? ` set the due date on checklist item${itemSuffix} to ${this.v(formatDueDate(p["dueDateLocalDate"] as string | null | undefined, p["dueDateSlot"] as DueDateSlotSelection | null | undefined, p["dueDateTimezone"] as string | null | undefined))}`
          : ` cleared the due date on checklist item${itemSuffix}`;
      }
      case "checklistItem:completion": {
        const text = typeof p["text"] === "string" ? ` ${this.v(p["text"])}` : "";
        return p["toValue"] === true ? ` completed checklist item${text}` : ` marked checklist item incomplete${text}`;
      }
      case "attachment_added": {
        const name = p["fileName"] as string | undefined;
        return name ? ` attached ${this.v(name)}` : " added an attachment";
      }
      case "attachment_removed": {
        const name = p["fileName"] as string | undefined;
        return name ? ` removed attachment ${this.v(name)}` : " removed an attachment";
      }
      case "cover_set":
        return " set a cover image";
      case "cover_removed":
        return " removed the cover image";
      default:
        return ` ${event.action.replace(/_/g, " ")} ${event.entityType}`;
    }
  }

  activityActorText(event: ActivityFeedEvent): string | null {
    if (event.action === "overdue" && event.actorKind === "system") return null;
    const copiedName = this.activityPayloadText(event.payload as Record<string, unknown>, "copiedActorName");
    return copiedName && event.actorKind === "system" ? `${event.actorName} (${copiedName})` : event.actorName;
  }

  isSystemActivity(event: ActivityFeedEvent): boolean {
    return event.actorKind === "system";
  }

  formatFeedTime(createdAt: string | Date): string {
    const date = new Date(createdAt as string);
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60_000);
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  reactionFor(comment: CommentRow, type: ReactionType): CommentReactionSummary | undefined {
    return comment.reactions?.find((r) => r.type === type);
  }

  userReacted(comment: CommentRow, type: ReactionType): boolean {
    const myId = this.currentUserId()?.id;
    if (!myId) return false;
    return Boolean(this.reactionFor(comment, type)?.userIds.includes(myId));
  }

  canViewReactions(): boolean {
    const role = this.state.viewerRole();
    return role !== null && role !== "observer";
  }

  // Whether this user could ever react (role + ownership, connectivity-independent). Drives
  // structural @if so the reaction button stays mounted across offline blips.
  canReactRole(comment: CommentRow): boolean {
    const myId = this.currentUserId()?.id;
    return this.canEdit() && this.canViewReactions() && Boolean(myId) && (comment.authorKind !== "user" || comment.authorId !== myId);
  }

  // Live gate: can react right now (also requires online). Drives disabled/readonly state + guards.
  canReact(comment: CommentRow): boolean {
    return this.canReactRole(comment) && this.sockets.displayedOnline();
  }

  async toggleReaction(comment: CommentRow, type: ReactionType) {
    if (!this.canReact(comment)) return;
    if (this.userReacted(comment, type)) {
      await this.api.delete(`/comments/${comment.id}/reactions/${type}`);
    } else {
      await this.api.post(`/comments/${comment.id}/reactions`, { type });
    }
  }

  openReactionPopover(event: MouseEvent, summary: CommentReactionSummary) {
    this.reactionPopoverAnchor.set(event.currentTarget as HTMLElement);
    this.reactionPopoverUsers.set(summary.users);
  }

  closeReactionPopover() {
    this.reactionPopoverAnchor.set(null);
    this.reactionPopoverUsers.set([]);
  }

  private sortFeed(items: CardFeedItem[]): CardFeedItem[] {
    // Parse each createdAt once up front (O(n)) rather than twice per comparison inside the
    // comparator (O(n log n) parses). sortFeed runs on every realtime upsert/merge, so this
    // keeps incoming activity cheap on long feeds.
    const times = new Map<CardFeedItem, number>();
    for (const item of items) times.set(item, new Date(item.data.createdAt as unknown as string).getTime());
    return [...items].sort((a, b) => {
      const ta = times.get(a)!;
      const tb = times.get(b)!;
      if (ta !== tb) return tb - ta;
      const priority = cardFeedSortPriority(a) - cardFeedSortPriority(b);
      if (priority !== 0) return priority;
      return String(a.data.id).localeCompare(String(b.data.id));
    });
  }

  private upsertFeedItem(items: CardFeedItem[], next: CardFeedItem): CardFeedItem[] {
    // The item is present again, so it must not stay tombstoned for later page merges.
    this.feedTombstones.delete(`${next.type}:${next.data.id}`);
    const withoutExisting = items.filter((item) => item.type !== next.type || item.data.id !== next.data.id);
    return this.applyPendingReactions(this.sortFeed([...withoutExisting, next]));
  }

  private mergeFeedPage(items: CardFeedItem[], pageItems: CardFeedItem[]): CardFeedItem[] {
    // Reconcile a (possibly stale) server page with the live in-memory feed. The page seeds the base
    // so it can contribute items we don't have yet; the current items are layered on top so a realtime
    // update/reaction that landed during the request wins over the page's older copy on key collision.
    // Tombstoned keys (realtime deletions) are dropped so a stale page can't resurrect them.
    const byKey = new Map<string, CardFeedItem>();
    for (const item of pageItems) byKey.set(`${item.type}:${item.data.id}`, item);
    for (const item of items) byKey.set(`${item.type}:${item.data.id}`, item);
    for (const key of this.feedTombstones) byKey.delete(key);
    return this.applyPendingReactions(this.sortFeed([...byKey.values()]));
  }

  private hasComment(items: CardFeedItem[], commentId: string): boolean {
    return items.some((item) => item.type === "comment" && item.data.id === commentId);
  }

  private queueReactionOperation(
    commentId: string,
    operation:
      | { kind: "add"; type: ReactionType; user: ReactionUserSummary }
      | { kind: "remove"; type: ReactionType; userId: string },
  ) {
    const pending = this.pendingReactionOperations.get(commentId) ?? [];
    pending.push(operation);
    this.pendingReactionOperations.set(commentId, pending);
  }

  private applyPendingReactions(items: CardFeedItem[]): CardFeedItem[] {
    let next = items;
    for (const [commentId, operations] of this.pendingReactionOperations) {
      if (!this.hasComment(next, commentId)) continue;
      for (const operation of operations) {
        next = operation.kind === "add"
          ? this.applyReactionAdded(next, commentId, operation.type, operation.user)
          : this.applyReactionRemoved(next, commentId, operation.type, operation.userId);
      }
      this.pendingReactionOperations.delete(commentId);
    }
    return next;
  }

  private persistFeedSnapshot(cardId: string, feed: CardFeedItem[]) {
    const detail = this.state.detailForCard(cardId);
    if (detail) {
      void this.offlineCache.saveCardDetail(cardId, detail, feed).catch(() => undefined);
      return;
    }
    // Feed and detail load independently; if a mutation lands first, preserve the
    // fresh comments/activity against the last cached detail instead of dropping it.
    void this.offlineCache.loadCardDetail(cardId)
      .then((cached) => {
        if (cached) return this.offlineCache.saveCardDetail(cardId, cached.detail, feed);
        return undefined;
      })
      .catch(() => undefined);
  }

  private applyReactionAdded(
    items: CardFeedItem[],
    commentId: string,
    type: ReactionType,
    user: ReactionUserSummary,
  ): CardFeedItem[] {
    return items.map((item) => {
      if (item.type !== "comment" || item.data.id !== commentId) return item;
      const reactions = [...(item.data.reactions ?? [])];
      const idx = reactions.findIndex((r) => r.type === type);
      if (idx === -1) {
        reactions.push({ type, count: 1, userIds: [user.id], users: [user] });
      } else if (!reactions[idx].userIds.includes(user.id)) {
        const existing = reactions[idx];
        reactions[idx] = {
          ...existing,
          count: existing.count + 1,
          userIds: [...existing.userIds, user.id],
          users: [...existing.users, user],
        };
      } else {
        return item;
      }
      return { type: "comment" as const, data: { ...item.data, reactions } };
    });
  }

  private applyReactionRemoved(
    items: CardFeedItem[],
    commentId: string,
    type: ReactionType,
    userId: string,
  ): CardFeedItem[] {
    return items.map((item) => {
      if (item.type !== "comment" || item.data.id !== commentId) return item;
      const reactions = (item.data.reactions ?? [])
        .map((r) => {
          if (r.type !== type) return r;
          if (!r.userIds.includes(userId)) return r;
          return {
            ...r,
            count: r.count - 1,
            userIds: r.userIds.filter((id) => id !== userId),
            users: r.users.filter((u) => u.id !== userId),
          };
        })
        .filter((r) => r.count > 0);
      return { type: "comment" as const, data: { ...item.data, reactions } };
    });
  }

  private v(s: string, variant?: "overdue"): string {
    const variantClass = variant ? ` activity-value-${variant}` : "";
    return `<span class="activity-value${variantClass}">${this.esc(s)}</span>`;
  }

  private arr(): string {
    return `<i class="activity-arrow ti ti-arrow-narrow-right"></i>`;
  }

  private esc(s: string): string {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private vField(value: unknown): string | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "boolean") return this.v(value ? "Yes" : "No");
    if (value === "true" || value === "false") return this.v(value === "true" ? "Yes" : "No");
    if (typeof value === "string" || typeof value === "number") {
      return this.v(String(value));
    }
    return null;
  }

  private activityPayloadNames(payload: Record<string, unknown>, key: string): string[] {
    const names = payload[key];
    if (!Array.isArray(names)) return [];
    return names.filter((name): name is string => typeof name === "string" && name.length > 0);
  }

  private activityNetAssigneeNames(payload: Record<string, unknown>): { added: string[]; removed: string[] } {
    const fromValue = this.activityPayloadNames(payload, "fromValue");
    const toValue = this.activityPayloadNames(payload, "toValue");
    if (!fromValue.length && !toValue.length) return { added: [], removed: [] };

    const fromIds = new Set(fromValue);
    const toIds = new Set(toValue);
    const namesById = payload["assigneeNamesById"] && typeof payload["assigneeNamesById"] === "object"
      ? payload["assigneeNamesById"] as Record<string, unknown>
      : {};
    const nameFor = (id: string) => typeof namesById[id] === "string" ? namesById[id] as string : id;

    return {
      added: toValue.filter((id) => !fromIds.has(id)).map(nameFor),
      removed: fromValue.filter((id) => !toIds.has(id)).map(nameFor),
    };
  }

  private activityAddedSelf(payload: Record<string, unknown>, event: ActivityFeedEvent): boolean {
    if (event.actorKind !== "user" || !event.actorId) return false;

    const fromValue = this.activityPayloadNames(payload, "fromValue");
    const toValue = this.activityPayloadNames(payload, "toValue");
    if (toValue.length > 0) {
      return toValue.includes(event.actorId) && !fromValue.includes(event.actorId);
    }

    const addedIds = this.activityPayloadNames(payload, "addedAssigneeIds");
    if (addedIds.length > 0) return addedIds.length === 1 && addedIds[0] === event.actorId;

    const addedNames = this.activityPayloadNames(payload, "addedAssigneeNames");
    return addedNames.length === 1 && addedNames[0] === event.actorName;
  }

  private activityPayloadText(payload: Record<string, unknown>, key: string): string | null {
    const value = payload[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private markdownAltText(value: string): string {
    return value.replace(/[[\]\\]/g, "\\$&");
  }

  private activityNameList(names: string[]): string {
    if (names.length === 1) return this.v(names[0]!);
    if (names.length === 2) return `${this.v(names[0]!)} and ${this.v(names[1]!)}`;
    return `${names.slice(0, -1).map((name) => this.v(name)).join(", ")}, and ${this.v(names[names.length - 1]!)}`;
  }

  private activityFieldName(payload: Record<string, unknown>): string {
    const fieldName = payload["fieldName"];
    return typeof fieldName === "string" && fieldName.length > 0 ? fieldName : "Custom field";
  }
}
