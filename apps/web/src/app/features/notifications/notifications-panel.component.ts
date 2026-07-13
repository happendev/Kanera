import { NgOptimizedImage } from "@angular/common";
import type { ElementRef} from "@angular/core";
import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal, viewChild } from "@angular/core";
import { Router } from "@angular/router";
import type { WireBoardMemberUser, WireCardSummary } from "@kanera/shared/events";
import type { Board, BoardRole, CardLabel, CustomField, List } from "@kanera/shared/schema";
import type { NotificationRow } from "@kanera/shared/dto";
import { ApiClient } from "../../core/api/api.client";
import { visibleSignedMediaUrl } from "../../core/media/signed-media-url";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { AvatarComponent } from "../../shared/avatar.component";
import { attachmentIconClass } from "../../shared/attachment-icons";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { CardActionsMenuPopover } from "../board/card-actions-menu.popover";
import { openCardDetailInNewTab } from "../board/card-navigation.util";
import { BoardState } from "../board/board-state";
import { DescriptionViewerComponent } from "../board/description-viewer.component";

interface ActivityChangeSummary {
  icon: string;
  text: string;
  value?: string;
}

@Component({
  selector: "k-notifications-panel",
  standalone: true,
  imports: [NgOptimizedImage, AvatarComponent, DescriptionViewerComponent, CardActionsMenuPopover, TooltipDirective],
  providers: [BoardState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./notifications-panel.component.html",
  styleUrl: "./notifications-panel.component.scss",
  host: { "[style.--bell-accent]": "workspaceAccentVar()" },
})
export class NotificationsPanelComponent {
  private readonly api = inject(ApiClient);
  private readonly notifications = inject(NotificationsService);
  private readonly router = inject(Router);
  private readonly boardState = inject(BoardState);
  private readonly workspaceService = inject(WorkspaceService);

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
  readonly availableBoards = this.workspaceService.notificationBoardOptions;
  readonly availableUsers = this.workspaceService.notificationUserOptions;
  readonly drawerBody = viewChild<ElementRef<HTMLElement>>("drawerBody");
  readonly loadMoreSentinel = viewChild<ElementRef<HTMLElement>>("loadMoreSentinel");
  readonly actionsMenuNotificationId = signal<string | null>(null);
  readonly actionsMenuPoint = signal<{ x: number; y: number } | null>(null);
  readonly actionsMenuLoadingNotificationId = signal<string | null>(null);

  private infiniteScrollObserver: IntersectionObserver | null = null;
  private drawerWasOffline = false;

  /** CSS var string for the workspace accent, or null to fall back to --accent. */
  readonly workspaceAccentVar = computed<string | null>(() => {
    const color = this.workspaceService.activeAccentColor();
    return color ? `var(--color-${color})` : null;
  });
  // The service projects `items` onto the active tab's feed (the unread feed is
  // already unread-only and drops rows the moment they're marked read), so the
  // panel renders it verbatim — no local include-read filtering needed.
  readonly displayedItems = this.items;
  readonly hasAny = computed(() => this.displayedItems().length > 0);
  readonly selectedBoardFilterFallbackId = computed(() => {
    const boardId = this.boardFilter();
    return boardId && !this.availableBoards().some((board) => board.boardId === boardId) ? boardId : null;
  });
  readonly selectedUserFilterFallbackId = computed(() => {
    const userId = this.userFilter();
    return userId && !this.availableUsers().some((user) => user.userId === userId) ? userId : null;
  });
  // True when a board or user filter is narrowing the list. Drives the toolbar
  // highlight and the filtered empty state, so a user who sees an unread badge
  // but an empty drawer understands a filter is hiding the rest.
  readonly hasActiveFilters = computed(() => Boolean(this.boardFilter() || this.userFilter()));
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
      const body = this.drawerBody()?.nativeElement;
      const sentinel = this.loadMoreSentinel()?.nativeElement;
      if (!this.open() || !body || !sentinel || typeof IntersectionObserver === "undefined") return;

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
  }

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

  async toggleIncludeRead(): Promise<void> {
    await this.notifications.setIncludeRead(!this.includeRead());
  }

  async setBoardFilter(boardId: string | null): Promise<void> {
    await this.notifications.setBoardFilter(boardId);
  }

  async setUserFilter(userId: string | null): Promise<void> {
    await this.notifications.setUserFilter(userId);
  }

  async clearFilters(): Promise<void> {
    await this.notifications.setBoardFilter(null);
    await this.notifications.setUserFilter(null);
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

  async toggleRead(event: Event, notification: NotificationRow): Promise<void> {
    event.stopPropagation();
    if (!this.online()) return;
    if (notification.readAt) {
      await this.notifications.markUnread(notification.id);
    } else {
      await this.notifications.markRead(notification.id);
    }
  }

  async markAllRead(): Promise<void> {
    if (!this.online()) return;
    await this.notifications.markAllRead();
  }

  async openNotification(notification: NotificationRow, event?: MouseEvent, options?: { lightboxAttachmentId?: string }): Promise<void> {
    event?.preventDefault();
    if (!notification.readAt && this.online()) {
      void this.notifications.markRead(notification.id);
    }
    if (notification.boardId && notification.cardId) {
      if (await this.openCardInCurrentAssignedWorkPage(notification.cardId, options?.lightboxAttachmentId)) {
        this.close();
        return;
      }
      await this.router.navigate(["/b", notification.boardId], {
        queryParams: { cardId: notification.cardId, lightboxAttachmentId: options?.lightboxAttachmentId ?? null },
        queryParamsHandling: "merge",
      });
      this.close();
    } else if (notification.boardId) {
      await this.router.navigate(["/b", notification.boardId]);
      this.close();
    }
  }

  notificationUrl(notification: NotificationRow): string {
    if (!notification.boardId) return "#";
    const boardUrl = `/b/${encodeURIComponent(notification.boardId)}`;
    return notification.cardId ? `${boardUrl}?cardId=${encodeURIComponent(notification.cardId)}` : boardUrl;
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
    await this.router.navigate(["/b", notification.boardId]);
    this.close();
  }

  openNotificationInNewTab(event: MouseEvent, notification: NotificationRow): void {
    if (event.button !== 1 || !notification.boardId) return;
    event.preventDefault();
    event.stopPropagation();
    if (!notification.readAt && this.online()) {
      void this.notifications.markRead(notification.id);
    }
    if (notification.cardId) {
      openCardDetailInNewTab(notification.boardId, notification.cardId);
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

  private async openCardInCurrentAssignedWorkPage(cardId: string, lightboxAttachmentId?: string): Promise<boolean> {
    const tree = this.router.parseUrl(this.router.url);
    const segments = tree.root.children["primary"]?.segments.map((segment) => segment.path) ?? [];
    const isAssignedWorkPage = segments.length >= 3 && segments[0] === "w" && (segments[2] === "team" || segments[2] === "u");
    if (!isAssignedWorkPage) return false;

    tree.queryParams = { ...tree.queryParams, cardId };
    if (lightboxAttachmentId) tree.queryParams["lightboxAttachmentId"] = lightboxAttachmentId;
    else delete tree.queryParams["lightboxAttachmentId"];
    await this.router.navigateByUrl(tree);
    return true;
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
