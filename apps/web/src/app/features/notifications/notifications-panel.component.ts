import { NgOptimizedImage } from "@angular/common";
import type { ElementRef} from "@angular/core";
import { ChangeDetectionStrategy, Component, DestroyRef, HostListener, computed, effect, inject, signal, viewChild } from "@angular/core";
import { Router } from "@angular/router";
import { cardPath } from "@kanera/shared/card-links";
import type { WireBoardMemberUser, WireCardSummary } from "@kanera/shared/events";
import type { Board, BoardRole, CardLabel, CustomField, List } from "@kanera/shared/schema";
import type { NotificationGroupBy, NotificationRow } from "@kanera/shared/dto";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { visibleSignedMediaUrl } from "../../core/media/signed-media-url";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { SocketService } from "../../core/realtime/socket.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { AvatarComponent } from "../../shared/avatar.component";
import { attachmentIconClass } from "../../shared/attachment-icons";
import { dayGroupLabel } from "../../shared/day-key.util";
import { SearchFieldComponent } from "../../shared/search-field.component";
import { SegmentedComponent, type SegmentedOption } from "../../shared/segmented.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { CardActionsMenuPopover } from "../board/card-actions-menu.popover";
import { openCardDetailInNewTab } from "../board/card-navigation.util";
import { BoardState } from "../board/board-state";
import { DescriptionViewerComponent } from "../board/description-viewer.component";
import { buildFeedEntries, type ActivityChangeSummary, type NotificationCluster, type NotificationFeedEntry } from "./notification-clusters";

interface NotificationGroupView {
  key: string;
  label: string;
  count: number;
  items: NotificationRow[];
  /** What actually renders: `items` projected onto rows and card+day blocks. */
  entries: NotificationFeedEntry[];
  icon: string;
  iconColor: string | null;
  avatarUrl: string | null;
  actorId: string | null;
  workspaceId: string;
}

const SEARCH_DEBOUNCE_MS = 200;

@Component({
  selector: "k-notifications-panel",
  standalone: true,
  imports: [NgOptimizedImage, AvatarComponent, DescriptionViewerComponent, CardActionsMenuPopover, SearchFieldComponent, SegmentedComponent, TooltipDirective],
  providers: [BoardState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./notifications-panel.component.html",
  styleUrl: "./notifications-panel.component.scss",
  host: { "[style.--bell-accent]": "workspaceAccentVar()" },
})
export class NotificationsPanelComponent {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly notifications = inject(NotificationsService);
  private readonly router = inject(Router);
  private readonly boardState = inject(BoardState);
  private readonly workspaceService = inject(WorkspaceService);
  private readonly sockets = inject(SocketService);
  private readonly destroyRef = inject(DestroyRef);

  // Hide an attachment thumbnail whose signed token has expired so a stale
  // notification payload shows the paperclip fallback instead of a 404 image.
  visibleThumbUrl(url: string | null | undefined): string | null {
    return visibleSignedMediaUrl(url);
  }

  attachmentIcon(mimeType: string, fileName: string): string {
    return attachmentIconClass(mimeType, fileName);
  }

  readonly open = signal(false);
  readonly closing = signal(false);
  readonly items = this.notifications.items;
  readonly unreadCount = this.notifications.unreadCount;
  readonly includeRead = this.notifications.includeRead;
  readonly online = this.notifications.online;
  readonly loading = this.notifications.loading;
  readonly loadError = this.notifications.loadError;
  readonly hasMore = this.notifications.hasMore;
  readonly boardFilter = this.notifications.boardFilter;
  readonly userFilter = this.notifications.userFilter;
  readonly groupBy = this.notifications.groupBy;
  readonly searchQuery = this.notifications.searchQuery;
  readonly searchInputValue = signal(this.searchQuery());
  readonly availableBoards = this.workspaceService.notificationBoardOptions;
  // Organisation members remain available even before they have generated a
  // notification. Actual notification actors extend that set with cross-org
  // board guests, which are intentionally absent from workspace membership.
  readonly availableUsers = computed(() => {
    const byId = new Map(this.workspaceService.notificationUserOptions().map((user) => [user.userId, user]));
    for (const actor of this.notifications.notificationUserOptions()) byId.set(actor.userId, actor);
    return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId));
  });
  readonly drawerBody = viewChild<ElementRef<HTMLElement>>("drawerBody");
  readonly loadMoreSentinel = viewChild<ElementRef<HTMLElement>>("loadMoreSentinel");
  readonly actionsMenuNotificationId = signal<string | null>(null);
  readonly actionsMenuPoint = signal<{ x: number; y: number } | null>(null);
  readonly actionsMenuLoadingNotificationId = signal<string | null>(null);
  // Group keys include their grouping mode (day, board, or user), so collapse
  // state can safely survive feed updates and switching between modes.
  readonly collapsedGroupKeys = signal<ReadonlySet<string>>(new Set());

  private infiniteScrollObserver: IntersectionObserver | null = null;
  private drawerWasOffline = false;
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** CSS var string for the workspace accent, or null to fall back to --accent. */
  readonly workspaceAccentVar = computed<string | null>(() => {
    const color = this.workspaceService.activeAccentColor();
    return color ? `var(--color-${color})` : null;
  });
  // The service projects `items` onto the active tab's feed (the unread feed is
  // already unread-only and drops rows the moment they're marked read), so the
  // panel renders it verbatim — no local include-read filtering needed.
  readonly displayedItems = this.items;
  readonly showOrganisationContext = computed(() => {
    const user = this.auth.user();
    if ((user?.organisations?.length ?? 1) > 1) return true;

    const activeClientId = user?.activeClientId ?? user?.clientId;
    // A user may belong to one organisation but still receive notifications from a board where
    // they are a cross-organisation guest. Keep the label for that genuinely ambiguous context.
    return !!activeClientId && this.displayedItems().some((notification) => notification.clientId !== activeClientId);
  });
  readonly displayedGroups = computed<NotificationGroupView[]>(() => {
    const groups = new Map<string, NotificationRow[]>();
    const ordered = [...this.displayedItems()].sort((a, b) => {
      const timeDelta = new Date(b.createdAt as unknown as string).getTime() - new Date(a.createdAt as unknown as string).getTime();
      return timeDelta || b.id.localeCompare(a.id);
    });
    for (const notification of ordered) {
      const key = this.notifications.groupKey(notification);
      const items = groups.get(key);
      if (items) items.push(notification);
      else groups.set(key, [notification]);
    }
    return [...groups.entries()].map(([key, items]) => this.toGroupView(key, items));
  });
  readonly hasAny = computed(() => this.displayedItems().length > 0);
  readonly selectedBoardFilterFallbackId = computed(() => {
    const boardId = this.boardFilter();
    return boardId && !this.availableBoards().some((board) => board.boardId === boardId) ? boardId : null;
  });
  readonly selectedUserFilterFallbackId = computed(() => {
    const userId = this.userFilter();
    return userId && !this.availableUsers().some((user) => user.userId === userId) ? userId : null;
  });
  // True when a board, user, or search filter is narrowing the list. Drives the toolbar
  // highlight and the filtered empty state, so a user who sees an unread badge
  // but an empty drawer understands a filter is hiding the rest.
  readonly hasActiveFilters = computed(() => Boolean(this.boardFilter() || this.userFilter() || this.searchInputValue().trim()));
  readonly hasUnresolvedUnreadMismatch = computed(() =>
    !this.includeRead() && !this.hasActiveFilters() && this.unreadCount() > 0 && this.displayedItems().length === 0,
  );
  readonly offlineTitle = "You're offline - changes are paused";

  constructor() {
    this.notifications.initialise();
    effect(() => {
      if (this.open()) {
        document.body.classList.add("k-no-scroll");
      } else {
        document.body.classList.remove("k-no-scroll");
      }
    });
    effect(() => {
      if (!this.open()) {
        this.drawerWasOffline = false;
        return;
      }
      if (!this.online()) {
        this.drawerWasOffline = true;
        return;
      }
      if (this.drawerWasOffline) {
        this.drawerWasOffline = false;
        void this.loadDrawer();
      }
    });
    effect((onCleanup) => {
      // Re-arm the observer whenever paging changes the rendered groups or a
      // user collapses one. A collapsed feed can leave the sentinel inside the
      // viewport, in which case IntersectionObserver would not cross a new
      // threshold and request the next page on its own. Card+day blocks do the
      // same thing without any user action: a 25-row page can render as a
      // handful of blocks, so paging must be free to fire again immediately.
      this.displayedGroups();
      this.collapsedGroupKeys();
      const loading = this.loading();
      const body = this.drawerBody()?.nativeElement;
      const sentinel = this.loadMoreSentinel()?.nativeElement;
      if (!this.open() || loading || !body || !sentinel || typeof IntersectionObserver === "undefined") return;

      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) void this.loadMore();
        },
        { root: body, rootMargin: "160px 0px 160px 0px" },
      );
      observer.observe(sentinel);
      this.infiniteScrollObserver = observer;
      onCleanup(() => {
        observer.disconnect();
        if (this.infiniteScrollObserver === observer) this.infiniteScrollObserver = null;
      });
    });
    this.destroyRef.onDestroy(() => {
      if (this.searchDebounceTimer !== null) clearTimeout(this.searchDebounceTimer);
    });
  }

  private toGroupView(key: string, items: NotificationRow[]): NotificationGroupView {
    const first = items[0]!;
    const activity = first.activity;
    const base = {
      key,
      // Always a *notification* count, taken from the server total where it is known: the bell
      // badge, the sidebar badges and this header must agree, and counting rendered blocks instead
      // would silently under-report a busy card.
      count: this.notifications.groupCount(key) || items.length,
      items,
      entries: buildFeedEntries(items, this.summariseRow),
      iconColor: null as string | null,
      avatarUrl: null as string | null,
      actorId: null as string | null,
      workspaceId: first.workspaceId,
    };
    if (this.groupBy() === "day") {
      // Shared day-key helpers, so this label and the card+day block boundary in
      // notification-clusters.ts can never drift onto different calendar days.
      return { ...base, label: dayGroupLabel(key.slice("day:".length)), icon: "ti ti-calendar" };
    }
    if (this.groupBy() === "board") {
      return {
        ...base,
        label: first.boardName ?? first.workspaceName ?? "Workspace",
        icon: `ti ti-${first.boardId ? first.boardIcon || "layout-kanban" : first.workspaceIcon || "building"}`,
        iconColor: first.boardIconColor,
      };
    }
    if (this.groupBy() === "organisation") {
      return { ...base, label: first.orgName, icon: "ti ti-building", avatarUrl: first.orgLogoUrl };
    }
    const isUser = activity?.actorKind === "user";
    return {
      ...base,
      label: isUser ? first.actorName ?? "Unknown user" : activity?.actorKind === "apiKey" ? first.actorName ?? "API key" : activity?.actorKind === "support" ? "Kanera support" : "Kanera",
      icon: activity?.actorKind === "apiKey" ? "ti ti-api" : activity?.actorKind === "support" ? "ti ti-lifebuoy" : "ti ti-sparkles",
      avatarUrl: isUser ? first.actorAvatarUrl : null,
      actorId: isUser ? activity.actorId : null,
    };
  }

  /** Bound so `buildFeedEntries` can precompute each block entry's action line without a closure per row. */
  private readonly summariseRow = (row: NotificationRow): ActivityChangeSummary => this.changeSummary(row);

  toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }
    this.closing.set(false);
    this.open.set(true);
    void this.loadDrawer();
  }

  private loadDrawer(): void {
    void this.notifications.loadFirstPage();
  }

  close(): void {
    if (!this.open() || this.closing()) return;
    this.closeActionsMenu();
    this.closing.set(true);
    setTimeout(() => {
      this.open.set(false);
      this.closing.set(false);
    }, 110);
  }

  @HostListener("document:keydown.escape")
  onEscape(): void {
    if (this.open()) this.close();
  }

  /**
   * Unread / All as a two-way segmented control. The pill treatment is the shared one, so this reads
   * the same as every other switch in the app; `size="sm"` keeps it inside the drawer's dense toolbar
   * grid, which a 36px control would not fit.
   */
  readonly readFilterOptions: SegmentedOption<"unread" | "all">[] = [
    { id: "unread", label: "Unread" },
    { id: "all", label: "All" },
  ];

  async setReadFilter(value: "unread" | "all"): Promise<void> {
    if ((value === "all") === this.includeRead()) return;
    await this.toggleIncludeRead();
  }

  async toggleIncludeRead(): Promise<void> {
    await this.notifications.setIncludeRead(!this.includeRead());
  }

  async setBoardFilter(boardId: string | null): Promise<void> {
    await this.notifications.setBoardFilter(boardId);
  }

  async setUserFilter(userId: string | null): Promise<void> {
    await this.notifications.setUserFilter(userId);
  }

  setSearchQuery(value: string): void {
    this.searchInputValue.set(value);
    if (this.searchDebounceTimer !== null) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    // Clearing applies at once rather than waiting out the debounce: the reader has asked to see
    // everything again, and a lag there reads as the clear button not working. This is why the shared
    // k-search-field can route its clear through the same handler instead of needing its own output.
    if (!value) {
      void this.notifications.setSearchQuery("");
      return;
    }
    this.searchDebounceTimer = setTimeout(() => {
      this.searchDebounceTimer = null;
      void this.notifications.setSearchQuery(value);
    }, SEARCH_DEBOUNCE_MS);
  }

  async setGroupBy(groupBy: NotificationGroupBy): Promise<void> {
    await this.notifications.setGroupBy(groupBy);
  }

  isGroupCollapsed(groupKey: string): boolean {
    return this.collapsedGroupKeys().has(groupKey);
  }

  toggleGroupCollapsed(groupKey: string): void {
    this.collapsedGroupKeys.update((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  async clearFilters(): Promise<void> {
    if (this.searchDebounceTimer !== null) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    this.searchInputValue.set("");
    await this.notifications.clearNotificationFilters();
  }

  async refreshNotifications(): Promise<void> {
    await this.notifications.loadFirstPage();
  }

  async loadMore(): Promise<void> {
    if (!this.hasMore() || this.loading()) return;
    await this.notifications.loadMore();
  }

  async markRead(event: Event, id: string): Promise<void> {
    event.stopPropagation();
    if (!this.online()) return;
    await this.notifications.markRead(id);
  }

  /**
   * Per-row read toggle. A card+day block has no per-entry toggle — it is read as one thing via
   * `markClusterRead` — but anything that clears one of a card's unread rows (this toggle on the All
   * tab, opening the card, a board mark-read, another session) drops it from the unread feed, so a
   * two-entry block degrades back to a plain row. That collapse is intended.
   */
  async toggleRead(event: Event, notification: NotificationRow): Promise<void> {
    event.stopPropagation();
    if (!this.online()) return;
    if (notification.readAt) {
      await this.notifications.markUnread(notification.id);
    } else {
      await this.notifications.markRead(notification.id);
    }
  }

  /** Clears a whole card+day block in one request. Blocks are unread-only, so there is no unread branch. */
  async markClusterRead(event: Event, cluster: NotificationCluster): Promise<void> {
    event.stopPropagation();
    if (!this.online()) return;
    await this.notifications.markManyRead(cluster.unreadIds);
  }

  /** Opening a block opens its card and clears every entry it holds, not just the head row. */
  async openCluster(cluster: NotificationCluster, event?: MouseEvent): Promise<void> {
    await this.openNotification(cluster.head, event, { readIds: cluster.unreadIds });
  }

  openClusterInNewTab(event: MouseEvent, cluster: NotificationCluster): void {
    this.openNotificationInNewTab(event, cluster.head, { readIds: cluster.unreadIds });
  }

  async markAllRead(): Promise<void> {
    if (!this.online()) return;
    await this.notifications.markAllRead();
  }

  /**
   * `options.readIds` lets a card+day block mark all of its entries while reusing this one
   * navigation path — the cross-organisation switch and the pretty card URL stay in one place.
   */
  async openNotification(notification: NotificationRow, event?: MouseEvent, options?: { lightboxAttachmentId?: string; readIds?: string[] }): Promise<void> {
    event?.preventDefault();
    if (!notification.readAt && this.online()) {
      void this.notifications.markManyRead(options?.readIds ?? [notification.id]);
    }
    if (notification.clientId !== this.auth.user()?.clientId) {
      this.sockets.pauseForOrganisationSwitch();
      try {
        await this.auth.switchOrg(notification.clientId);
        this.sockets.resumeAfterOrganisationSwitch();
        window.location.assign(this.notificationUrl(notification));
      } catch {
        this.sockets.resumeAfterOrganisationSwitch();
      }
      return;
    }
    if (notification.boardId && notification.cardId && notification.organisationKey && notification.cardKey) {
      await this.router.navigate(["/b", notification.boardId, "c", notification.cardId], {
        queryParams: { cardId: null, lightboxAttachmentId: options?.lightboxAttachmentId ?? null },
        queryParamsHandling: "merge",
        browserUrl: cardPath(notification.organisationKey, notification.cardKey),
      });
      this.close();
    } else if (notification.boardId) {
      await this.router.navigate(["/b", notification.boardId]);
      this.close();
    }
  }

  notificationUrl(notification: NotificationRow): string {
    if (!notification.boardId) return "#";
    if (notification.organisationKey && notification.cardKey) {
      return cardPath(notification.organisationKey, notification.cardKey);
    }
    return `/b/${encodeURIComponent(notification.boardId)}`;
  }

  attachmentImageMarkdown(notification: NotificationRow): string | null {
    const attachment = notification.attachment;
    if (!attachment?.mimeType.startsWith("image/")) return null;
    const src = visibleSignedMediaUrl(attachment.url);
    if (!src) return null;
    return `![${this.markdownAltText(attachment.fileName)}](${src})`;
  }

  async openNotificationAttachmentImage(notification: NotificationRow): Promise<void> {
    const attachment = notification.attachment;
    if (!attachment?.id || !attachment.mimeType.startsWith("image/")) return;
    await this.openNotification(notification, undefined, { lightboxAttachmentId: attachment.id });
  }

  async openBoard(event: Event, notification: NotificationRow): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!notification.boardId) return;
    if (notification.clientId !== this.auth.user()?.clientId) {
      await this.openNotification(notification);
      return;
    }
    await this.router.navigate(["/b", notification.boardId]);
    this.close();
  }

  openNotificationInNewTab(event: MouseEvent, notification: NotificationRow, options?: { readIds?: string[] }): void {
    if (event.button !== 1 || !notification.boardId) return;
    event.preventDefault();
    event.stopPropagation();
    if (!notification.readAt && this.online()) {
      void this.notifications.markManyRead(options?.readIds ?? [notification.id]);
    }
    if (notification.cardId && notification.organisationKey && notification.cardKey) {
      openCardDetailInNewTab(notification.organisationKey, notification.cardKey);
      return;
    }
    window.open(`/b/${encodeURIComponent(notification.boardId)}`, "_blank", "noopener");
  }

  openBoardInNewTab(event: MouseEvent, notification: NotificationRow): void {
    if (event.button !== 1 || !notification.boardId) return;
    event.preventDefault();
    event.stopPropagation();
    window.open(`/b/${encodeURIComponent(notification.boardId)}`, "_blank", "noopener");
  }

  canShowCardActions(notification: NotificationRow): boolean {
    return Boolean(notification.cardId && notification.boardId && notification.viewerRole && notification.viewerRole !== "observer");
  }

  async openCardActions(event: MouseEvent, notification: NotificationRow): Promise<void> {
    if (!this.canShowCardActions(notification)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!notification.boardId) return;
    this.actionsMenuLoadingNotificationId.set(notification.id);
    try {
      await this.ensureBoardMenuState(notification);
    } catch {
      return;
    } finally {
      if (this.actionsMenuLoadingNotificationId() === notification.id) this.actionsMenuLoadingNotificationId.set(null);
    }
    this.actionsMenuNotificationId.set(notification.id);
    this.actionsMenuPoint.set({ x: event.clientX, y: event.clientY });
  }

  closeActionsMenu(): void {
    this.actionsMenuNotificationId.set(null);
    this.actionsMenuPoint.set(null);
  }

  private async ensureBoardMenuState(notification: NotificationRow): Promise<void> {
    const boardId = notification.boardId;
    if (!boardId) return;
    const cardId = notification.cardId;
    const hasCurrentCard = cardId ? this.boardState.cards().some((card) => card.id === cardId) : true;
    if (this.boardState.board()?.id === boardId && hasCurrentCard) return;
    const suffix = notification.cardArchivedAt ? "?archived=true" : "";
    const payload = await this.api.post<{
      board: Board;
      lists: List[];
      cards: WireCardSummary[];
      customFields: CustomField[];
      cardLabels: CardLabel[];
      members: WireBoardMemberUser[];
      viewerRole: BoardRole;
      viewerSource?: "board" | "workspace";
    }>(`/boards/${boardId}/open${suffix}`, {});
    this.boardState.hydrate(payload);
  }

  actorInitial(n: NotificationRow): string {
    return (n.actorName || "K").charAt(0).toUpperCase();
  }

  relativeTime(value: string | Date): string {
    const ts = typeof value === "string" ? new Date(value).getTime() : value.getTime();
    const diff = Date.now() - ts;
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return "just now";
    if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
    if (diff < day) return `${Math.floor(diff / hour)}h ago`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  changeSummary(n: NotificationRow): ActivityChangeSummary {
    // Checklist-item overdue rows carry no activity, so this must precede the
    // generic overdue branch below (which would otherwise read as "card is overdue").
    if (n.reason === "checklist_item_overdue") {
      return { icon: "ti ti-calendar-exclamation", text: "checklist item is overdue" };
    }
    if (n.reason === "overdue" || !n.activity) {
      return { icon: "ti ti-calendar-exclamation", text: "card is overdue" };
    }
    const activity = n.activity;
    const payload = (activity.payload ?? {}) as Record<string, unknown>;
    switch (activity.entityType) {
      case "comment":
        return {
          icon: "ti ti-message-circle-2",
          text: activity.action === "created" ? "commented" : activity.action === "updated" ? "edited a comment" : "removed a comment",
        };
      case "card": {
        switch (activity.action) {
          case "created": {
            const copiedFrom = this.shortName(payload["duplicatedFromBoardName"]) ?? this.shortName(payload["duplicatedFromBoardId"]);
            if (copiedFrom) return { icon: "ti ti-copy", text: "copied this card from", value: copiedFrom };
            if (typeof payload["duplicatedFromId"] === "string") return { icon: "ti ti-copy", text: "copied this card from", value: "another board" };
            return { icon: "ti ti-plus", text: "created this card" };
          }
          case "deleted":
            return { icon: "ti ti-trash", text: "deleted this card" };
          case "moved":
            return { icon: "ti ti-arrows-right-left", text: "moved this card to", value: n.listName ?? "another list" };
          case "completed":
            return { icon: "ti ti-circle-check", text: "marked this card complete" };
          case "uncompleted":
            return { icon: "ti ti-circle", text: "marked this card incomplete" };
          case "completion:set":
            return {
              icon: payload["toValue"] === true ? "ti ti-circle-check" : "ti ti-circle",
              text: payload["toValue"] === true ? "marked this card complete" : "marked this card incomplete",
            };
          case "attachment_added":
            return { icon: "ti ti-paperclip", text: `attached ${this.shortName(payload["fileName"]) ?? "a file"}` };
          case "attachment_removed":
            return { icon: "ti ti-paperclip", text: `removed an attachment` };
          case "assignees:set": {
            const added = (payload["addedAssigneeNames"] as string[]) ?? [];
            const removed = (payload["removedAssigneeNames"] as string[]) ?? [];
            const parts: string[] = [];
            if (added.length) parts.push(this.addedSelf(payload, activity, n) ? "assigned themself" : `assigned ${added.join(", ")}`);
            if (removed.length) parts.push(`unassigned ${removed.join(", ")}`);
            return { icon: "ti ti-user", text: parts.join(" · ") || "changed assignees" };
          }
          case "labels:set": {
            const added = (payload["addedLabelNames"] as string[]) ?? [];
            const removed = (payload["removedLabelNames"] as string[]) ?? [];
            const parts: string[] = [];
            if (added.length) parts.push(`added label ${added.join(", ")}`);
            if (removed.length) parts.push(`removed label ${removed.join(", ")}`);
            return { icon: "ti ti-tag", text: parts.join(" · ") || "updated labels" };
          }
          case "updated": {
            const title = payload["title"];
            const description = payload["description"];
            if (typeof title === "string") return { icon: "ti ti-pencil", text: `renamed to "${title}"` };
            if (description !== undefined) return { icon: "ti ti-pencil", text: "edited the description" };
            if (payload["dueDateLocalDate"] !== undefined) return { icon: "ti ti-calendar", text: payload["dueDateLocalDate"] ? "updated the due date" : "removed the due date" };
            return { icon: "ti ti-pencil", text: "updated this card" };
          }
          case "customFieldValue:set": {
            const name = (payload["fieldName"] as string) ?? "field";
            const raw = payload["toValue"];
            if (raw == null || raw === "") return { icon: "ti ti-forms", text: `cleared ${name}` };
            let to = "";
            if (typeof raw === "string") to = raw;
            else if (typeof raw === "number" || typeof raw === "boolean") to = String(raw);
            else if (raw != null) to = JSON.stringify(raw);
            return { icon: "ti ti-forms", text: `set ${name} to`, value: this.shortName(to) ?? undefined };
          }
          case "cover_set":
            return { icon: "ti ti-photo", text: "set the cover image" };
          case "cover_removed":
            return { icon: "ti ti-photo-off", text: "removed the cover image" };
          case "checklist:created":
            return { icon: "ti ti-list-check", text: "added checklist", value: this.shortName(payload["title"]) ?? undefined };
          case "checklist:deleted":
            return { icon: "ti ti-trash", text: "deleted checklist", value: this.shortName(payload["title"]) ?? undefined };
          case "checklist:completed": {
            const title = this.shortName(payload["title"]);
            const parentItemText = this.shortName(payload["parentItemText"]);
            if (parentItemText) {
              return {
                icon: "ti ti-circle-check",
                text: "completed sub-checklist",
                value: title ? `${title} on ${parentItemText}` : `on ${parentItemText}`,
              };
            }
            return { icon: "ti ti-circle-check", text: "completed checklist", value: title ?? undefined };
          }
          case "checklist:renamed":
            return { icon: "ti ti-pencil", text: "renamed checklist to", value: this.shortName(payload["toValue"]) ?? undefined };
          case "checklistItem:updated":
            return { icon: "ti ti-pencil", text: "edited checklist item", value: this.shortName(payload["toValue"]) ?? undefined };
          case "checklistItem:description:set":
            return { icon: "ti ti-align-left", text: payload["toValue"] ? "updated a checklist item description" : "cleared a checklist item description", value: this.shortName(payload["itemText"]) ?? undefined };
          case "checklistItem:assignee:set": {
            const assigneeName = typeof payload["assigneeName"] === "string" ? payload["assigneeName"] : null;
            const previousAssigneeName = typeof payload["previousAssigneeName"] === "string" ? payload["previousAssigneeName"] : null;
            return {
              icon: "ti ti-user-check",
              text: assigneeName && previousAssigneeName
                ? `changed assignee from ${previousAssigneeName} to ${assigneeName}`
                : assigneeName ? `assigned ${assigneeName} to checklist item` : "unassigned checklist item",
              value: this.shortName(payload["itemText"]) ?? undefined,
            };
          }
          case "checklistItem:completion":
            return {
              icon: payload["toValue"] === true ? "ti ti-checkbox" : "ti ti-square",
              text: payload["toValue"] === true ? "completed checklist item" : "marked checklist item incomplete",
              value: this.shortName(payload["text"]) ?? undefined,
            };
          case "checklistItem:created":
            return { icon: "ti ti-list-check", text: "added checklist item", value: this.shortName(payload["text"]) ?? undefined };
          case "checklistItem:deleted":
            return { icon: "ti ti-trash", text: "deleted checklist item", value: this.shortName(payload["text"]) ?? undefined };
          default:
            return { icon: "ti ti-history", text: this.humanizeAction(activity.action) };
        }
      }
      default:
        return { icon: "ti ti-history", text: this.humanizeAction(activity.action) };
    }
  }

  private shortName(value: unknown): string | null {
    if (typeof value !== "string") return null;
    if (value.length <= 40) return value;
    return value.slice(0, 37) + "…";
  }

  private markdownAltText(value: string): string {
    return value.replace(/[\\[\]]/g, "\\$&");
  }

  private activityPayloadNames(payload: Record<string, unknown>, key: string): string[] {
    const names = payload[key];
    if (!Array.isArray(names)) return [];
    return names.filter((name): name is string => typeof name === "string" && name.length > 0);
  }

  private addedSelf(payload: Record<string, unknown>, activity: NonNullable<NotificationRow["activity"]>, notification: NotificationRow): boolean {
    if (activity.actorKind !== "user" || !activity.actorId) return false;

    const fromValue = this.activityPayloadNames(payload, "fromValue");
    const toValue = this.activityPayloadNames(payload, "toValue");
    if (toValue.length > 0) {
      return toValue.includes(activity.actorId) && !fromValue.includes(activity.actorId);
    }

    const addedIds = this.activityPayloadNames(payload, "addedAssigneeIds");
    if (addedIds.length > 0) return addedIds.length === 1 && addedIds[0] === activity.actorId;

    const addedNames = this.activityPayloadNames(payload, "addedAssigneeNames");
    return addedNames.length === 1 && addedNames[0] === notification.actorName;
  }

  private humanizeAction(action: string): string {
    return action
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[:_]+/g, " ")
      .toLowerCase();
  }
}
