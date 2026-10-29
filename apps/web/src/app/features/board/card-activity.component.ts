import { CdkTrapFocus } from "@angular/cdk/a11y";
import type { ElementRef } from "@angular/core";
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
import type { CardAttachmentRow, CardFeedPage, CommentReactionSummary, ReactionType, ReactionUserSummary } from "@kanera/shared/dto";
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
import { attachmentPreviewType, type AttachmentPreviewType } from "../../shared/attachment-preview";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { AvatarComponent } from "../../shared/avatar.component";
import { SystemAvatarComponent } from "../../shared/system-avatar.component";
import { DraftBannerComponent } from "../../shared/draft-banner.component";
import { hasMarkdownContent } from "../../shared/markdown-content";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { BoardState } from "./board-state";
import { DescriptionEditorComponent, type EditorSaveEvent } from "./description-editor.component";
import { descriptionDiff, hasDescriptionChanges, hasDescriptionDiffPayload, type DescriptionDiff } from "./description-diff";
import { DescriptionViewerComponent } from "./description-viewer.component";
import { formatDueDate, type DueDateSlotSelection } from "./due-date.util";
import { ImageLightboxService } from "./image-lightbox.service";
import { ReactionPopoverComponent } from "./reaction-popover.component";
import { feedDayGroup, feedDayGroupLabel, formatFeedTime, type FeedDayGroup } from "../../shared/date-format";
import { icu } from "../../core/i18n/icu";
import { appLocale } from "../../core/i18n/locale";
import { formatTrackedDuration } from "./time-in-progress.util";

const CARD_FEED_PAGE_SIZE = 50;

// The live attachment behind an activity row, when it still exists. Reactions and "comment on this"
// target the attachment itself, so a deleted upload's history row shows its preview but no actions.
type ActivityAttachmentTarget = Pick<CardAttachmentRow, "id" | "fileName" | "mimeType" | "url" | "uploadedById" | "uploadedByName" | "reactions">;

type ActivityAttachmentPreview =
  | { kind: "image"; markdown: string; attachmentId: string; target: ActivityAttachmentTarget }
  | {
      kind: "file";
      target: ActivityAttachmentTarget | null;
      fileName: string;
      iconClass: string;
      thumbnailUrl: string | null;
      url: string | null;
      mimeType: string;
      mediaType: Exclude<AttachmentPreviewType, "image"> | null;
    };

function cardFeedSortPriority(item: CardFeedItem): number {
  return item.type === "activity" && item.data.entityType === "card" && item.data.action === "created" ? 0 : 1;
}

// Precomputed render shape for a feed row. The activity-only fields (html, actorText, isSystem)
// and the relative time are pure functions of immutable item data, so deriving them once in a
// computed avoids re-running the ~170-line activityText switch / Date parsing for every row on
// every change detection pass (keystrokes, hovers, popover toggles).
type CardFeedView =
  | { kind: "comment"; key: string; data: CommentRow; timeText: string; isMirror: boolean }
  | { kind: "day"; key: string; label: string }
  | {
      kind: "activity";
      key: string;
      data: ActivityFeedEvent;
      timeText: string;
      isSystem: boolean;
      isMirror: boolean;
      actorText: string | null;
      html: string;
      hasDescriptionChanges: boolean;
      attachmentPreview: ActivityAttachmentPreview | null;
      runSummary: string | null;
    };

let listFormat: Intl.ListFormat | null = null;

// Shared by several activity cases; functions so they read like the inline messages around them.
const MARKED_COMPLETE = () => $localize`:Card activity after a person's name:marked this card complete`;
const MARKED_INCOMPLETE = () => $localize`:Card activity after a person's name:marked this card incomplete`;
const EMPTY_VALUE = () => $localize`:Stands in for a blank value in card activity, e.g. "Priority - empty → High":empty`;
const YES = () => $localize`:Checkbox field value in card activity:Yes`;
const NO = () => $localize`:Checkbox field value in card activity:No`;

@Component({
  selector: "k-card-activity",
  standalone: true,
  imports: [CdkTrapFocus, 
    AnchoredPanelDirective,
    AvatarComponent,
    SystemAvatarComponent,
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
  readonly canDeleteAnyCommentRole = computed(() => this.canEdit() && this.state.viewerIsWorkspaceAdmin());

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
  // Feed rows the panel will actually draw; the header count uses this too so it never promises
  // rows the reader cannot find.
  // - Aggregate rows left by older mirror workers are hidden; the rich source activities are the
  //   audit trail and make an unexplained "N mirrored changes" entry redundant and misleading.
  // - agentRun:started is recorded for audit (run start/end never notifies), but the live run block above the
  //   fields already shows in-flight work, so the feed only carries the outcome (agentRun:ended).
  readonly renderableFeedItems = computed(() =>
    this.feedItems().filter((item) =>
      item.type !== "activity" || (item.data.coalesceKey !== "card:mirrorSync" && item.data.action !== "agentRun:started"),
    ),
  );
  readonly filteredFeedItems = computed(() => {
    const q = this.commentSearchQuery().trim().toLowerCase();
    const renderableItems = this.renderableFeedItems();
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
  // Rows are banded by local day (Today / Yesterday / This week / Earlier): a heading row is
  // emitted where the band changes, so a feed that is all from today carries one heading and a
  // long history reads as four. The feed is newest-first, so bands run in that order too.
  readonly feedViewItems = computed<CardFeedView[]>(() => {
    const now = new Date();
    const rows: CardFeedView[] = [];
    let group: FeedDayGroup | null = null;
    for (const item of this.filteredFeedItems()) {
      const itemGroup = feedDayGroup(item.data.createdAt, now);
      if (itemGroup !== group) {
        group = itemGroup;
        rows.push({ kind: "day", key: `day:${itemGroup}`, label: feedDayGroupLabel(itemGroup) });
      }
      rows.push(this.feedRowFor(item));
    }
    return rows;
  });

  private feedRowFor(item: CardFeedItem): CardFeedView {
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
        hasDescriptionChanges: this.hasDescriptionChangesForActivity(item.data),
        attachmentPreview: this.attachmentPreviewForActivity(item.data),
        runSummary: this.runSummaryForActivity(item.data),
      };
  }

  showAuthorPresence(authorKind: string, authorId: string | null): boolean {
    return authorKind === "user" && Boolean(authorId && this.memberIds().has(authorId));
  }

  copiedSystemAuthorName(comment: CommentRow): string | null {
    return comment.authorKind === "system" && comment.apiKeyName ? comment.apiKeyName : null;
  }

  isOwnComment(comment: CommentRow): boolean {
    return comment.authorKind === "user" && comment.authorId === this.currentUserId()?.id;
  }

  canDeleteCommentRole(comment: CommentRow): boolean {
    return this.canEdit() && (this.isOwnComment(comment) || this.canDeleteAnyCommentRole());
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

  @HostListener("document:keydown.escape")
  onEscape() {
    this.closeDescriptionDiff();
  }

  toggleCommentSearch() {
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
    // The rich editor consumes its value only at creation time. Mirror live text here so an
    // offline/visibility remount reopens the composer with the current draft, not an empty body.
    this.newCommentInitialValue.set(markdown);
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
    // A composer holding only blank lines must not overwrite a stored draft that has real text.
    const markdown = hasMarkdownContent(editorMarkdown) ? editorMarkdown! : existingDraft?.markdown ?? editorMarkdown ?? "";
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
      ? $localize`:Header of a quoted comment in a reply; person is a mention of the original author:${`@[${comment.authorName}](kanera-user:${comment.authorId})`}:person: wrote:`
      : `**${$localize`:Header of a quoted comment in a reply:${comment.authorName}:person: wrote:`}**`;
    const quotedBody = comment.body
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    // Attribution line, the quoted body, then a blank line for the reply.
    return `> ${attribution}\n>\n${quotedBody}\n\n`;
  }

  startReplyComment(comment: CommentRow) {
    if (!this.canMutate()) return;
    this.openComposerWithQuote(this.buildReplyQuote(comment));
  }

  // Quotes the attachment and mentions the uploader so feedback on their screenshot reaches them.
  // Images are quoted as the picture itself (shown as a thumbnail inside quotes) so the comment and
  // its notification read on their own; other files keep a link chip.
  private buildAttachmentQuote(attachment: ActivityAttachmentTarget): string {
    const ownUpload = attachment.uploadedById === this.currentUserId()?.id;
    const mention = `@[${attachment.uploadedByName}](kanera-user:${attachment.uploadedById})`;
    if (attachment.mimeType.startsWith("image/")) {
      const image = `![${this.markdownAltText(attachment.fileName)}](${attachment.url})`;
      if (ownUpload) return `> ${image}\n\n`;
      return `> ${$localize`:Header above an image quoted at the top of a new comment; person is a mention of the uploader:${mention}:person: attached:`}\n>\n> ${image}\n\n`;
    }
    const link = `[${this.markdownAltText(attachment.fileName)}](${attachment.url})`;
    const header = ownUpload
      ? link
      : $localize`:Header quoting an attachment at the top of a new comment; person is a mention of the uploader:${link}:file: from ${mention}:person:`;
    return `> ${header}\n\n`;
  }

  startAttachmentComment(attachment: ActivityAttachmentTarget) {
    if (!this.canMutate()) return;
    this.openComposerWithQuote(this.buildAttachmentQuote(attachment));
  }

  private openComposerWithQuote(quote: string) {
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
    // Blank lines and hard breaks serialise to markdown that survives trim() but renders as nothing.
    if (!hasMarkdownContent(body)) {
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
    // Keep the remount seed aligned with the mounted editor; otherwise an automatic unmount can
    // recreate the editor from the original comment body and hide the user's local edit.
    this.editCommentBody.set(markdown);
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
    // Emptying a comment down to blank lines is not an edit worth saving; keep the editor open.
    if (!hasMarkdownContent(body)) {
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

  // Activities are immutable snapshots; weak keys let removed/paged-out rows be collected. Feed
  // refreshes reuse the cheap eligibility result, and only the opened modal computes a full diff.
  private readonly descriptionChangeCache = new WeakMap<ActivityFeedEvent, boolean>();
  private readonly descriptionDiffCache = new WeakMap<ActivityFeedEvent, DescriptionDiff>();

  private hasDescriptionChangesForActivity(event: ActivityFeedEvent): boolean {
    const cached = this.descriptionChangeCache.get(event);
    if (cached !== undefined) return cached;
    const payload = event.payload as Record<string, unknown>;
    const eligible = event.entityType === "card" && event.action === "updated"
      && "description" in payload && hasDescriptionDiffPayload(payload)
      && typeof payload["fromValue"] === "string" && payload["fromValue"].trim().length > 0
      && hasDescriptionChanges(payload["fromValue"], payload["toValue"]);
    this.descriptionChangeCache.set(event, eligible);
    return eligible;
  }

  descriptionDiffForActivity(event: ActivityFeedEvent): DescriptionDiff | null {
    if (!this.hasDescriptionChangesForActivity(event)) return null;
    const cached = this.descriptionDiffCache.get(event);
    if (cached) return cached;
    const payload = event.payload as Record<string, unknown>;
    const diff = descriptionDiff(payload["fromValue"], payload["toValue"]);
    this.descriptionDiffCache.set(event, diff);
    return diff;
  }

  /**
   * The run's closing summary is the outcome a reader actually wants; the run row itself is gone
   * from card detail once it ends, so this is where that note lives. Agents write it like a comment,
   * so it renders like one (markdown in a comment body) under the headline.
   */
  runSummaryForActivity(event: ActivityFeedEvent): string | null {
    if (event.action !== "agentRun:ended") return null;
    return this.activityPayloadText(event.payload as Record<string, unknown>, "summary");
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
    const fileName = attachment?.fileName ?? (typeof payload["fileName"] === "string" ? payload["fileName"] : $localize`:Stand-in name for an unnamed file:attachment`);
    if (mimeType.startsWith("image/")) {
      const src = visibleSignedMediaUrl(attachment?.url);
      if (!src) return null;
      return {
        kind: "image",
        attachmentId,
        target: attachment!,
        markdown: `![${this.markdownAltText(fileName)}](${src})`,
      };
    }
    const previewType = attachmentPreviewType(mimeType, fileName);
    return {
      kind: "file",
      target: attachment ?? null,
      fileName,
      iconClass: attachmentIconClass(mimeType, fileName),
      thumbnailUrl: visibleSignedMediaUrl(attachment?.thumbnailUrl),
      url: visibleSignedMediaUrl(attachment?.url),
      mimeType,
      mediaType: previewType === "image" ? null : previewType,
    };
  }

  openActivityAttachmentImage(attachmentId: string, event?: Event) {
    const attachment = this.state.coverAttachmentById().get(attachmentId);
    const src = visibleSignedMediaUrl(attachment?.url);
    if (!src) return;
    this.imageLightbox.open({ src, fileName: attachment?.fileName, createdAt: attachment?.createdAt }, event);
  }

  openActivityAttachment(
    attachment: Extract<ActivityAttachmentPreview, { kind: "file" }>,
    event?: Event,
  ) {
    if (!attachment.mediaType) return;
    event?.preventDefault();
    event?.stopPropagation();
    if (!attachment.url) return;
    this.imageLightbox.open({
      src: attachment.url,
      fileName: attachment.fileName,
      mediaType: attachment.mediaType,
      mimeType: attachment.mimeType,
    }, event);
  }

  openCommentAttachment(attachment: {
    src: string;
    fileName: string;
    mediaType: AttachmentPreviewType;
    mimeType: string;
  }, event?: Event) {
    // Comment attachments are rendered from durable markdown rather than the detail attachment
    // collection, so open the signed URL carried by the link in the shared media lightbox.
    this.imageLightbox.open({
      src: attachment.src,
      fileName: attachment.fileName,
      mediaType: attachment.mediaType,
      mimeType: attachment.mimeType,
    }, event);
  }

  // Each phrase follows the actor's name, which the template renders separately ("Priya" + " moved
  // to [Doing]"), so the messages are written to read after a person's name. Values arrive as
  // pre-escaped HTML spans; pass them through icu() values or named placeholders, never into the
  // ICU text itself.
  activityText(event: ActivityFeedEvent): string {
    const p = event.payload as Record<string, unknown>;
    const count = event.coalescedCount;
    switch (event.action) {
      case "created": {
        const sourceBoardName = this.activityPayloadText(p, "duplicatedFromBoardName");
        const sourceBoardId = typeof p["duplicatedFromBoardId"] === "string" ? p["duplicatedFromBoardId"] : null;
        const board = sourceBoardName ?? sourceBoardId;
        if (board) return ` ${$localize`:Card activity after a person's name:copied this card from ${this.v(board)}:board:`}`;
        if (typeof p["duplicatedFromId"] === "string") return ` ${$localize`:Card activity after a person's name:copied this card from another board`}`;
        if (typeof p["importedFrom"] === "string") return ` ${$localize`:Card activity after a person's name:imported this card`}`;
        return ` ${$localize`:Card activity after a person's name:created this card`}`;
      }
      case "updated": {
        const title = p["title"];
        if (typeof title === "string") return ` ${$localize`:Card activity after a person's name:renamed this card to ${this.v(title)}:title:`}`;
        if ("description" in p) {
          return ` ${icu($localize`:Card activity after a person's name; several edits merged into one row:{count, plural, =1 {updated the description} other {updated the description # times}}`, { count: Math.max(1, count) })}`;
        }
        if ("dueDateLocalDate" in p) {
          return p["dueDateLocalDate"]
            ? ` ${$localize`:Card activity after a person's name:set the due date to ${this.v(this.activityDueDate(p))}:date:`}`
            : ` ${$localize`:Card activity after a person's name:cleared the due date`}`;
        }
        return ` ${$localize`:Card activity after a person's name:updated this card`}`;
      }
      case "moved": {
        const lists = this.state.lists();
        const to = lists.find((l) => l.id === p["toListId"]);
        const from = lists.find((l) => l.id === p["fromListId"]);
        const toName = to?.name ?? this.activityPayloadText(p, "toListName");
        const fromName = from?.name ?? this.activityPayloadText(p, "fromListName");
        if (toName && fromName) {
          return ` ${$localize`:Card activity after a person's name; arrow is an icon between the two list names:moved from ${this.listChip(fromName, from)}:fromList: ${this.arr()}:arrow: ${this.listChip(toName, to)}:toList:`}`;
        }
        if (toName) return ` ${$localize`:Card activity after a person's name:moved to ${this.listChip(toName, to)}:list:`}`;
        return ` ${$localize`:Card activity after a person's name:moved this card`}`;
      }
      case "completed":
        return ` ${MARKED_COMPLETE()}`;
      case "uncompleted":
        return ` ${MARKED_INCOMPLETE()}`;
      case "completion:set":
        if (count > 1) {
          return p["toValue"] === true
            ? ` ${icu($localize`:Card activity after a person's name; several toggles merged into one row:{count, plural, other {toggled this card complete # times; left it complete}}`, { count })}`
            : ` ${icu($localize`:Card activity after a person's name; several toggles merged into one row:{count, plural, other {toggled this card complete # times; left it incomplete}}`, { count })}`;
        }
        return p["toValue"] === true ? ` ${MARKED_COMPLETE()}` : ` ${MARKED_INCOMPLETE()}`;
      case "overdue":
        return $localize`:Card activity shown without a person; overdue is a highlighted status word:This card is marked as ${this.v($localize`:Card status:overdue`, "overdue")}:overdue:`;
      case "inProgress:tooLong":
        return icu($localize`:Card activity shown without a person - the card passed the workspace's time in progress alert:{days, plural, one {This card has been in progress for more than # day} other {This card has been in progress for more than # days}}`, { days: Math.max(0, Number(p["alertDays"]) || 0) });
      case "schedule:conflict": {
        // Key only, like relations: this feed's readers may not be able to open the blocker.
        const other = this.v(this.activityPayloadText(p, "otherCardKey") ?? "?");
        return $localize`:Card activity shown without a person - the card's planned start is before the planned finish of the named card that blocks it:Scheduling conflict: this card is planned to start before ${other}:card: finishes`;
      }
      case "deleted":
        return ` ${$localize`:Card activity after a person's name:deleted this card`}`;
      case "labels:set": {
        const addedNames = this.activityPayloadNames(p, "addedLabelNames");
        if (addedNames.length > 0) {
          return ` ${icu($localize`:Card activity after a person's name; labels is a list of label names:{count, plural, =1 {added label {labels}} other {added labels {labels}}}`, { count: addedNames.length, labels: this.activityNameList(addedNames) })}`;
        }

        const removedNames = this.activityPayloadNames(p, "removedLabelNames");
        if (removedNames.length > 0) {
          return ` ${icu($localize`:Card activity after a person's name; labels is a list of label names:{count, plural, =1 {removed label {labels}} other {removed labels {labels}}}`, { count: removedNames.length, labels: this.activityNameList(removedNames) })}`;
        }

        const names = this.activityPayloadNames(p, "labelNames");
        if (names.length === 0 && Array.isArray(p["labelIds"]) && p["labelIds"].length === 0) return ` ${$localize`:Card activity after a person's name:cleared all labels`}`;
        return ` ${$localize`:Card activity after a person's name:updated the labels`}`;
      }
      case "assignees:set": {
        const netNames = this.activityNetAssigneeNames(p);
        const addedNames = netNames.added.length ? netNames.added : this.activityPayloadNames(p, "addedAssigneeNames");
        const removedNames = netNames.removed.length ? netNames.removed : this.activityPayloadNames(p, "removedAssigneeNames");
        const addedSelf = addedNames.length > 0 && this.activityAddedSelf(p, event);
        const added = addedNames.length > 0 ? this.activityNameList(addedNames) : null;
        const removed = removedNames.length > 0 ? this.activityNameList(removedNames) : null;
        if (added && removed) {
          return addedSelf
            ? ` ${$localize`:Card activity after a person's name:assigned themself and unassigned ${removed}:removed:`}`
            : ` ${$localize`:Card activity after a person's name:assigned ${added}:added: and unassigned ${removed}:removed:`}`;
        }
        if (added) {
          return addedSelf
            ? ` ${$localize`:Card activity after a person's name; they assigned the card to themselves:assigned themself`}`
            : ` ${$localize`:Card activity after a person's name:assigned ${added}:people:`}`;
        }
        if (removed) return ` ${$localize`:Card activity after a person's name:unassigned ${removed}:people:`}`;

        const ids = p["assigneeIds"] as string[] | undefined;
        return ids?.length
          ? ` ${$localize`:Card activity after a person's name:updated the assignees`}`
          : ` ${$localize`:Card activity after a person's name:removed all assignees`}`;
      }
      case "customFieldValue:set": {
        const field = this.v(this.activityFieldName(p));
        const from = this.vField(p["fromValue"]);
        const to = this.vField(p["toValue"]) ?? EMPTY_VALUE();
        if (count > 1) {
          return ` ${icu($localize`:Card activity after a person's name; arrow is an icon between the old and new values:{count, plural, other {changed {field} # times: {from} {arrow} {to}}}`, { count, field, from: from ?? EMPTY_VALUE(), arrow: this.arr(), to })}`;
        }
        if (!from) return ` ${$localize`:Card activity after a person's name:set ${field}:field: to ${to}:value:`}`;
        return ` ${$localize`:Card activity after a person's name; arrow is an icon between the old and new values:changed ${field}:field:: ${from}:from: ${this.arr()}:arrow: ${to}:to:`}`;
      }
      case "customFieldValue:cleared": {
        const field = this.v(this.activityFieldName(p));
        const from = this.vField(p["fromValue"]);
        return from
          ? ` ${$localize`:Card activity after a person's name; from is the previous value:cleared ${field}:field: (was ${from}:from:)`}`
          : ` ${$localize`:Card activity after a person's name:cleared ${field}:field:`}`;
      }
      case "checklist:created": {
        const title = this.activityPayloadText(p, "title");
        return title
          ? ` ${$localize`:Card activity after a person's name:added checklist ${this.v(title)}:checklist:`}`
          : ` ${$localize`:Card activity after a person's name:added a checklist`}`;
      }
      case "checklist:deleted": {
        const title = this.activityPayloadText(p, "title");
        return title
          ? ` ${$localize`:Card activity after a person's name:deleted checklist ${this.v(title)}:checklist:`}`
          : ` ${$localize`:Card activity after a person's name:deleted a checklist`}`;
      }
      case "checklist:completed": {
        const title = this.activityPayloadText(p, "title");
        const parentItemText = this.activityPayloadText(p, "parentItemText");
        if (parentItemText) {
          return title
            ? ` ${$localize`:Card activity after a person's name; item is the checklist item the sub-checklist belongs to:completed sub-checklist ${this.v(title)}:checklist: on ${this.v(parentItemText)}:item:`}`
            : ` ${$localize`:Card activity after a person's name; item is the checklist item the sub-checklist belongs to:completed a sub-checklist on ${this.v(parentItemText)}:item:`}`;
        }
        return title
          ? ` ${$localize`:Card activity after a person's name:completed checklist ${this.v(title)}:checklist:`}`
          : ` ${$localize`:Card activity after a person's name:completed a checklist`}`;
      }
      case "checklist:renamed": {
        const from = this.vField(p["fromValue"]) ?? EMPTY_VALUE();
        const to = this.vField(p["toValue"]) ?? EMPTY_VALUE();
        if (count > 1) {
          return ` ${icu($localize`:Card activity after a person's name; arrow is an icon between the old and new names:{count, plural, other {renamed a checklist # times: {from} {arrow} {to}}}`, { count, from, arrow: this.arr(), to })}`;
        }
        return ` ${$localize`:Card activity after a person's name; arrow is an icon between the old and new names:renamed a checklist: ${from}:from: ${this.arr()}:arrow: ${to}:to:`}`;
      }
      case "checklistItem:created": {
        if (count > 1) {
          const checklistTitle = this.activityPayloadText(p, "checklistTitle");
          return checklistTitle
            ? ` ${icu($localize`:Card activity after a person's name:{count, plural, other {added # checklist items to {checklist}}}`, { count, checklist: this.v(checklistTitle) })}`
            : ` ${icu($localize`:Card activity after a person's name:{count, plural, other {added # checklist items}}`, { count })}`;
        }
        const text = this.activityPayloadText(p, "text");
        return text
          ? ` ${$localize`:Card activity after a person's name:added checklist item ${this.v(text)}:item:`}`
          : ` ${$localize`:Card activity after a person's name:added a checklist item`}`;
      }
      case "checklistItem:deleted": {
        const text = this.activityPayloadText(p, "text");
        return text
          ? ` ${$localize`:Card activity after a person's name:deleted checklist item ${this.v(text)}:item:`}`
          : ` ${$localize`:Card activity after a person's name:deleted a checklist item`}`;
      }
      case "checklistItem:updated": {
        const from = this.vField(p["fromValue"]) ?? EMPTY_VALUE();
        const to = this.vField(p["toValue"]) ?? EMPTY_VALUE();
        if (count > 1) {
          return ` ${icu($localize`:Card activity after a person's name; arrow is an icon between the old and new text:{count, plural, other {edited a checklist item # times: {from} {arrow} {to}}}`, { count, from, arrow: this.arr(), to })}`;
        }
        return ` ${$localize`:Card activity after a person's name; arrow is an icon between the old and new text:edited a checklist item: ${from}:from: ${this.arr()}:arrow: ${to}:to:`}`;
      }
      case "checklistItem:description:set": {
        const itemText = this.activityPayloadText(p, "itemText");
        const item = itemText ? this.v(itemText) : null;
        if (p["toValue"]) {
          return item
            ? ` ${$localize`:Card activity after a person's name:updated the checklist item description for ${item}:item:`}`
            : ` ${$localize`:Card activity after a person's name:updated the checklist item description`}`;
        }
        return item
          ? ` ${$localize`:Card activity after a person's name:cleared the checklist item description for ${item}:item:`}`
          : ` ${$localize`:Card activity after a person's name:cleared the checklist item description`}`;
      }
      case "checklistItem:assignee:set": {
        if (p["bulk"] === true) {
          const items = typeof p["itemCount"] === "number" ? p["itemCount"] : 0;
          const assigneeName = this.activityPayloadText(p, "assigneeName");
          const checklistTitle = this.activityPayloadText(p, "checklistTitle");
          const values = { count: items, person: assigneeName ? this.v(assigneeName) : null, checklist: checklistTitle ? this.v(checklistTitle) : null };
          if (assigneeName) {
            return checklistTitle
              ? ` ${icu($localize`:Card activity after a person's name:{count, plural, =1 {assigned {person} to 1 checklist item in {checklist}} other {assigned {person} to # checklist items in {checklist}}}`, values)}`
              : ` ${icu($localize`:Card activity after a person's name:{count, plural, =1 {assigned {person} to 1 checklist item} other {assigned {person} to # checklist items}}`, values)}`;
          }
          return checklistTitle
            ? ` ${icu($localize`:Card activity after a person's name:{count, plural, =1 {unassigned 1 checklist item in {checklist}} other {unassigned # checklist items in {checklist}}}`, values)}`
            : ` ${icu($localize`:Card activity after a person's name:{count, plural, =1 {unassigned 1 checklist item} other {unassigned # checklist items}}`, values)}`;
        }
        const itemText = this.activityPayloadText(p, "itemText");
        const assigneeName = this.activityPayloadText(p, "assigneeName");
        const previousAssigneeName = this.activityPayloadText(p, "previousAssigneeName");
        const item = itemText ? this.v(itemText) : null;
        if (assigneeName && previousAssigneeName) {
          const previous = this.v(previousAssigneeName);
          const next = this.v(assigneeName);
          return item
            ? ` ${$localize`:Card activity after a person's name:changed checklist item ${item}:item: assignee from ${previous}:previous: to ${next}:next:`}`
            : ` ${$localize`:Card activity after a person's name:changed checklist item assignee from ${previous}:previous: to ${next}:next:`}`;
        }
        if (assigneeName) {
          const person = this.v(assigneeName);
          return item
            ? ` ${$localize`:Card activity after a person's name:assigned ${person}:person: to checklist item ${item}:item:`}`
            : ` ${$localize`:Card activity after a person's name:assigned ${person}:person: to checklist item`}`;
        }
        if (previousAssigneeName) {
          const person = this.v(previousAssigneeName);
          return item
            ? ` ${$localize`:Card activity after a person's name:removed ${person}:person: from checklist item ${item}:item:`}`
            : ` ${$localize`:Card activity after a person's name:removed ${person}:person: from checklist item`}`;
        }
        return item
          ? ` ${$localize`:Card activity after a person's name:updated checklist item assignee ${item}:item:`}`
          : ` ${$localize`:Card activity after a person's name:updated checklist item assignee`}`;
      }
      case "checklistItem:dueDate:set": {
        if (p["bulk"] === true) {
          const items = typeof p["itemCount"] === "number" ? p["itemCount"] : 0;
          const checklistTitle = this.activityPayloadText(p, "checklistTitle");
          const values = {
            count: items,
            checklist: checklistTitle ? this.v(checklistTitle) : null,
            date: p["dueDateLocalDate"] ? this.v(this.activityDueDate(p)) : null,
          };
          if (p["dueDateLocalDate"]) {
            return checklistTitle
              ? ` ${icu($localize`:Card activity after a person's name:{count, plural, =1 {set the due date on 1 checklist item in {checklist} to {date}} other {set the due date on # checklist items in {checklist} to {date}}}`, values)}`
              : ` ${icu($localize`:Card activity after a person's name:{count, plural, =1 {set the due date on 1 checklist item to {date}} other {set the due date on # checklist items to {date}}}`, values)}`;
          }
          return checklistTitle
            ? ` ${icu($localize`:Card activity after a person's name:{count, plural, =1 {cleared the due date on 1 checklist item in {checklist}} other {cleared the due date on # checklist items in {checklist}}}`, values)}`
            : ` ${icu($localize`:Card activity after a person's name:{count, plural, =1 {cleared the due date on 1 checklist item} other {cleared the due date on # checklist items}}`, values)}`;
        }
        const itemText = this.activityPayloadText(p, "itemText");
        const item = itemText ? this.v(itemText) : null;
        if (p["dueDateLocalDate"]) {
          const date = this.v(this.activityDueDate(p));
          return item
            ? ` ${$localize`:Card activity after a person's name:set the due date on checklist item ${item}:item: to ${date}:date:`}`
            : ` ${$localize`:Card activity after a person's name:set the due date on checklist item to ${date}:date:`}`;
        }
        return item
          ? ` ${$localize`:Card activity after a person's name:cleared the due date on checklist item ${item}:item:`}`
          : ` ${$localize`:Card activity after a person's name:cleared the due date on checklist item`}`;
      }
      case "checklistItem:completion": {
        const item = typeof p["text"] === "string" ? this.v(p["text"]) : null;
        if (p["toValue"] === true) {
          return item
            ? ` ${$localize`:Card activity after a person's name:completed checklist item ${item}:item:`}`
            : ` ${$localize`:Card activity after a person's name:completed checklist item`}`;
        }
        return item
          ? ` ${$localize`:Card activity after a person's name:marked checklist item incomplete ${item}:item:`}`
          : ` ${$localize`:Card activity after a person's name:marked checklist item incomplete`}`;
      }
      case "attachment_added": {
        const name = p["fileName"] as string | undefined;
        // Only infer deletion after full detail has loaded; a board summary does not include
        // every attachment. Read the live rows so remote deletions update the original activity.
        const attachmentId = p["attachmentId"];
        const deleted = typeof attachmentId === "string" && this.state.detailForCard(this.cardId())
          && !this.state.coverAttachmentById().has(attachmentId);
        if (deleted) {
          return name
            ? ` ${$localize`:Card activity after a person's name:attached ${this.v(name)}:fileName: (has since been deleted)`}`
            : ` ${$localize`:Card activity after a person's name:added an attachment (has since been deleted)`}`;
        }
        return name
          ? ` ${$localize`:Card activity after a person's name:attached ${this.v(name)}:fileName:`}`
          : ` ${$localize`:Card activity after a person's name:added an attachment`}`;
      }
      case "attachment_removed": {
        const name = p["fileName"] as string | undefined;
        return name
          ? ` ${$localize`:Card activity after a person's name:removed attachment ${this.v(name)}:fileName:`}`
          : ` ${$localize`:Card activity after a person's name:removed an attachment`}`;
      }
      case "cover_set":
        return ` ${$localize`:Card activity after a person's name:set a cover image`}`;
      case "cover_removed":
        return ` ${$localize`:Card activity after a person's name:removed the cover image`}`;
      case "inProgressTime:set": {
        const from = formatTrackedDuration(Math.max(0, Number(p["fromSeconds"]) || 0) * 1000);
        const to = formatTrackedDuration(Math.max(0, Number(p["toSeconds"]) || 0) * 1000);
        return ` ${$localize`:Card activity after a person's name - a workspace admin corrected tracked time, e.g. from 96h 20m to 80h:changed the time in progress from ${this.v(from)}:from: to ${this.v(to)}:to:`}`;
      }
      case "relation:added":
      case "relation:removed": {
        // Only the other card's key is recorded: this feed's readers may not be able to open it.
        const key = this.activityPayloadText(p, "otherCardKey") ?? "?";
        const other = this.v(key);
        const added = event.action === "relation:added";
        switch (p["direction"]) {
          case "blocks":
            return added
              ? ` ${$localize`:Card activity after a person's name - another card now waits on this one:marked this card as blocking ${other}:card:`}`
              : ` ${$localize`:Card activity after a person's name:removed that this card blocks ${other}:card:`}`;
          case "blocked_by":
            return added
              ? ` ${$localize`:Card activity after a person's name - this card now waits on another card:marked this card as blocked by ${other}:card:`}`
              : ` ${$localize`:Card activity after a person's name:removed that this card is blocked by ${other}:card:`}`;
          default:
            return added
              ? ` ${$localize`:Card activity after a person's name:related this card to ${other}:card:`}`
              : ` ${$localize`:Card activity after a person's name:removed the relation to ${other}:card:`}`;
        }
      }
      case "blockers:cleared": {
        // Key only, like relations: this feed's readers may not be able to open the blocker.
        const other = this.v(this.activityPayloadText(p, "otherCardKey") ?? "?");
        return ` ${$localize`:Card activity after a person's name - they completed or archived the named card, which left this one with no open blockers:cleared the last blocker on this card, ${other}:card:`}`;
      }
      case "blockers:reopened": {
        const other = this.v(this.activityPayloadText(p, "otherCardKey") ?? "?");
        return ` ${$localize`:Card activity after a person's name - they reopened or restored the named card, so this one is blocked again:reopened a blocker on this card, ${other}:card:`}`;
      }
      case "agentRun:ended": {
        const title = this.activityPayloadText(p, "title");
        const status = this.activityPayloadText(p, "status");
        // Stalls are recorded by the system (nobody acted), so name the agent explicitly.
        const agent = event.actorKind === "system" ? this.activityPayloadText(p, "agentName") : null;
        const subject = agent
          ? icu($localize`:Card activity after a system name; agent is an AI agent's name:{status, select, succeeded {marked {agent}'s run as finished} failed {marked {agent}'s run as failed} cancelled {marked {agent}'s run as cancelled} stalled {marked {agent}'s run as stalled} other {marked {agent}'s run as ended}}`, { status, agent: this.v(agent) })
          : icu($localize`:Card activity after an AI agent's name; a run title may follow after a colon:{status, select, succeeded {finished} failed {failed} cancelled {cancelled} stalled {stalled on} other {ended}}`, { status });
        // The title is the agent's own prose, not a changed value, so it reads as text rather than a
        // value pill. The closing summary renders under the row (runSummaryForActivity).
        const runTitle = title ? `<span class="activity-run-title">${this.esc(title)}</span>` : null;
        return ` ${runTitle ? $localize`:Agent run outcome followed by the run title:${subject}:outcome:: ${runTitle}:title:` : subject}`;
      }
      default:
        // Unknown actions from a newer server: show the raw action and entity type rather than nothing.
        return ` ${event.action.replace(/_/g, " ")} ${event.entityType}`;
    }
  }

  readonly clickToEditLabel = $localize`:Tooltip on a saved comment draft:Click to edit`;

  viaAgentLabel(agentName: string | null | undefined): string {
    return agentName
      ? $localize`:Marks a comment or change made by an AI agent, e.g. "via Claude":via ${agentName}:agent:`
      : $localize`:Marks a comment or change made by an unnamed AI agent:via AI agent`;
  }

  writtenByAgentTooltip(agentName: string | null | undefined, personName: string): string {
    return agentName
      ? $localize`:Tooltip on a comment an AI agent wrote for a person:Written by ${agentName}:agent: on behalf of ${personName}:person:`
      : $localize`:Tooltip on a comment an AI agent wrote for a person:Written by an AI agent on behalf of ${personName}:person:`;
  }

  doneByAgentTooltip(agentName: string | null | undefined, personName: string): string {
    return agentName
      ? $localize`:Tooltip on a change an AI agent made for a person:Done by ${agentName}:agent: on behalf of ${personName}:person:`
      : $localize`:Tooltip on a change an AI agent made for a person:Done by an AI agent on behalf of ${personName}:person:`;
  }

  activityActorText(event: ActivityFeedEvent): string | null {
    if ((event.action === "overdue" || event.action === "inProgress:tooLong" || event.action === "schedule:conflict") && event.actorKind === "system") return null;
    const copiedName = this.activityPayloadText(event.payload as Record<string, unknown>, "copiedActorName");
    return copiedName && event.actorKind === "system" ? `${event.actorName} (${copiedName})` : event.actorName;
  }

  isSystemActivity(event: ActivityFeedEvent): boolean {
    return event.actorKind === "system";
  }

  formatFeedTime(createdAt: string | Date): string {
    return formatFeedTime(createdAt);
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

  attachmentReaction(attachment: ActivityAttachmentTarget, type: ReactionType): CommentReactionSummary | undefined {
    return attachment.reactions?.find((r) => r.type === type);
  }

  attachmentUserReacted(attachment: ActivityAttachmentTarget, type: ReactionType): boolean {
    const myId = this.currentUserId()?.id;
    return Boolean(myId && this.attachmentReaction(attachment, type)?.userIds.includes(myId));
  }

  // Same rules as comments: editors only, and nobody reacts to their own upload.
  canReactToAttachmentRole(attachment: ActivityAttachmentTarget): boolean {
    const myId = this.currentUserId()?.id;
    return this.canEdit() && this.canViewReactions() && Boolean(myId) && attachment.uploadedById !== myId;
  }

  canReactToAttachment(attachment: ActivityAttachmentTarget): boolean {
    return this.canReactToAttachmentRole(attachment) && this.sockets.displayedOnline();
  }

  async toggleAttachmentReaction(attachment: ActivityAttachmentTarget, type: ReactionType) {
    if (!this.canReactToAttachment(attachment)) return;
    if (this.attachmentUserReacted(attachment, type)) {
      await this.api.delete(`/attachments/${attachment.id}/reactions/${type}`);
    } else {
      await this.api.post(`/attachments/${attachment.id}/reactions`, { type });
    }
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

  /**
   * A list named in a row wears the same icon-and-colour pill it has in the table and calendar, so
   * "moved to Review" is recognisable at a glance. The colour rides on a class, not a style: this
   * HTML goes through [innerHTML], whose sanitizer drops inline styles but keeps classes (the
   * matching `.is-<colour>` rules are generated in shared/_list-chip.scss). A list that has been
   * deleted since (name from the payload only) falls back to the plain value pill.
   */
  private listChip(name: string, list: { icon: string | null; color: string | null } | undefined): string {
    if (!list) return this.v(name);
    const color = list.color ? ` is-${this.esc(list.color)}` : "";
    return `<span class="activity-list${color}"><i class="ti ti-${this.esc(list.icon || "list")}"></i><span>${this.esc(name)}</span></span>`;
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
    if (typeof value === "boolean") return this.v(value ? YES() : NO());
    if (value === "true" || value === "false") return this.v(value === "true" ? YES() : NO());
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

  private activityDueDate(payload: Record<string, unknown>): string {
    return formatDueDate(
      payload["dueDateLocalDate"] as string | null | undefined,
      payload["dueDateSlot"] as DueDateSlotSelection | null | undefined,
      payload["dueDateTimezone"] as string | null | undefined,
    );
  }

  private activityPayloadText(payload: Record<string, unknown>, key: string): string | null {
    const value = payload[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private markdownAltText(value: string): string {
    return value.replace(/[[\]\\]/g, "\\$&");
  }

  private activityNameList(names: string[]): string {
    // The language's own list joiners ("A, B and C", "A、B、C"), with each name wrapped as a value.
    // Names are formatted as opaque tokens first so a comma or "and" inside a name stays intact.
    listFormat ??= new Intl.ListFormat(appLocale(), { type: "conjunction" });
    return listFormat.formatToParts(names)
      .map((part) => part.type === "element" ? this.v(part.value) : this.esc(part.value))
      .join("");
  }

  private activityFieldName(payload: Record<string, unknown>): string {
    const fieldName = payload["fieldName"];
    return typeof fieldName === "string" && fieldName.length > 0 ? fieldName : $localize`:Stand-in for an unnamed custom field:Custom field`;
  }
}
