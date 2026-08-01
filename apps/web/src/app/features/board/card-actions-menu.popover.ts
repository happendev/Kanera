import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import { Router } from "@angular/router";
import type { WireCard, WireList } from "@kanera/shared/events";
import { cardPath } from "@kanera/shared/card-links";
import { ApiClient } from "../../core/api/api.client";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { ANCHORED_HOST_STYLES } from "../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { BoardPickerPopover, type BoardPickerPick } from "./board-picker.popover";
import { BoardState } from "./board-state";
import { CardQuickEditPopover } from "./card-quick-edit.popover";
import type { DueDateSlotSelection } from "./due-date.util";

@Component({
  selector: "k-card-actions-menu",
  standalone: true,
  imports: [BoardPickerPopover, CardQuickEditPopover],
  hostDirectives: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cam-panel">
      <button type="button" class="cam-item" (click)="openInNewTab($event)">
        <i class="ti ti-external-link"></i>
        <span>Open in new tab</span>
      </button>


      <div class="cam-sub">
        <button type="button" class="cam-item" [class.is-active]="quickEditOpen()" (click)="toggleQuickEdit($event)">
          <i class="ti ti-pencil"></i>
          <span>Quick edit…</span>
          <i class="ti ti-chevron-right cam-chev"></i>
        </button>
        @if (quickEditOpen()) {
          <k-card-quick-edit
            [cardId]="cardId()"
            [title]="title()"
            [dueDateLocalDate]="dueDateLocalDate()"
            [dueDateSlotValue]="dueDateSlot()"
            [dueDateTimezone]="dueDateTimezone()"
            (close)="quickEditOpen.set(false)"
          />
        }
      </div>
      @if (showCardWatchAction()) {
      <button type="button" class="cam-item" (click)="toggleWatch($event)" [disabled]="savingWatch()">
        <i [class]="isWatchingCard() ? 'ti ti-eye-off' : 'ti ti-eye'"></i>
        <span>{{ isWatchingCard() ? 'Stop watching' : 'Watch card' }}</span>
      </button>
      }
      @if (allowDuplicate()) {
      <button type="button" class="cam-item" (click)="duplicate($event)" [disabled]="duplicating()">
        <i class="ti ti-copy"></i>
        <span>Duplicate card</span>
      </button>
      }
      <button type="button" class="cam-item" (click)="toggleCompletion($event)" [disabled]="savingCompletion()">
        <i [class]="completedAt() ? 'ti ti-circle' : 'ti ti-circle-check'"></i>
        <span>{{ completedAt() ? 'Mark incomplete' : 'Mark complete' }}</span>
      </button>
      @if (workspaceId()) {
        @if (allowCopyToBoard()) {
        <div class="cam-sub">
          <button type="button" class="cam-item" [class.is-active]="copyOpen()" (click)="toggleCopy($event)">
            <i class="ti ti-copy-plus"></i>
            <span>Copy to board…</span>
            <i class="ti ti-chevron-right cam-chev"></i>
          </button>
          @if (copyOpen()) {
            <k-board-picker
              [sourceBoardId]="boardId()"
              [excludeBoardId]="boardId()"
              [allowCrossWorkspace]="true"
              [sourceWorkspaceId]="workspaceId()"
              [sourceListId]="sourceListId()"
              [sourceLists]="sourceLists()"
              title="Copy to board"
              (pick)="onCopyPick($event)"
              (close)="copyOpen.set(false)"
            />
          }
        </div>
        }
        @if (canMoveToBoard()) {
        <div class="cam-sub">
          <button type="button" class="cam-item" [class.is-active]="moveOpen()" (click)="toggleMove($event)">
            <i class="ti ti-arrow-right"></i>
            <span>Move to board…</span>
            <i class="ti ti-chevron-right cam-chev"></i>
          </button>
          @if (moveOpen()) {
            <k-board-picker
              [sourceBoardId]="boardId()"
              [excludeBoardId]="boardId()"
              title="Move to board"
              (pick)="onMovePick($event)"
              (close)="moveOpen.set(false)"
            />
          }
        </div>
        }
      }
      <button type="button" class="cam-item" (click)="copyCardLink($event)">
        <i class="ti ti-link"></i>
        <span>Copy card link</span>
      </button>
      @if (cardKey()) {
      <button type="button" class="cam-item" (click)="copyCardKey($event)">
        <i class="ti ti-hash"></i>
        <span>Copy key</span>
      </button>
      }
      <div class="cam-sep"></div>
      @if (archivedAt()) {
        <button type="button" class="cam-item" (click)="setArchived($event, false)" [disabled]="archiving()">
          <i class="ti ti-archive-off"></i>
          <span>Unarchive card</span>
        </button>
      } @else if (confirmingDelete()) {
        <div class="cam-confirm">
          <span class="cam-confirm-label">Archive this card?</span>
          <button type="button" class="cam-confirm-yes" (click)="setArchived($event, true)" [disabled]="archiving()">Archive</button>
          <button type="button" class="cam-confirm-cancel" (click)="$event.preventDefault(); $event.stopPropagation(); confirmingDelete.set(false)">Cancel</button>
        </div>
      } @else {
        <button type="button" class="cam-item cam-item-danger" (click)="$event.preventDefault(); $event.stopPropagation(); confirmingDelete.set(true)">
          <i class="ti ti-archive"></i>
          <span>Archive card</span>
        </button>
      }
    </div>
  `,
  styles: [
    ANCHORED_HOST_STYLES,
    `
    .cam-panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
      padding: 4px;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .cam-sub {
      position: relative;
    }

    .cam-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 7px 10px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      color: var(--text);
      background: transparent;
      border: none;
      cursor: pointer;
      text-align: left;
      transition: background 0.1s;

      > i {
        font-size: 14px;
        flex-shrink: 0;
        width: 16px;
        color: var(--text-muted);
      }

      > span {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .cam-chev {
        color: var(--text-muted);
        margin-left: auto;
        font-size: 12px;
      }

      &:hover,
      &.is-active {
        background: var(--surface-hover);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      &.cam-item-danger {
        color: var(--danger, #d33);

        > i {
          color: var(--danger, #d33);
        }

        &:hover {
          background: color-mix(in srgb, var(--danger, #d33) 10%, transparent);
        }
      }
    }

    .cam-sep {
      height: 1px;
      background: var(--border);
      margin: 3px 0;
    }

    .cam-confirm {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px;
      min-width: 0;
    }

    .cam-confirm-label {
      font-size: 12px;
      color: var(--text-muted);
      flex: 1 1 auto;
      min-width: 0;
      line-height: 1.2;
    }

    .cam-confirm-yes {
      font-size: 12px;
      font-weight: 600;
      padding: 3px 7px;
      border-radius: var(--radius-sm);
      border: none;
      cursor: pointer;
      background: var(--danger, #d33);
      color: #fff;
      transition: opacity 0.1s;
      flex: 0 0 auto;

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .cam-confirm-cancel {
      font-size: 12px;
      padding: 3px 5px;
      border-radius: var(--radius-sm);
      border: none;
      cursor: pointer;
      background: transparent;
      color: var(--text-muted);
      transition: background 0.1s;
      flex: 0 0 auto;

      &:hover {
        background: var(--surface-hover);
        color: var(--text);
      }
    }
  `,
  ],
})
export class CardActionsMenuPopover {
  private readonly panel = inject(AnchoredPanelDirective);
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly state = inject(BoardState, { optional: true });
  private readonly notifications = inject(NotificationsService);

  readonly cardId = input.required<string>();
  readonly cardKey = input<string | null>(null);
  readonly organisationKey = input<string | null>(null);
  readonly boardId = input.required<string>();
  readonly workspaceId = input<string | null>(null);
  readonly sourceListId = input<string | null>(null);
  readonly sourceLists = input<Pick<WireList, "id" | "name">[]>([]);
  readonly title = input.required<string>();
  readonly dueDateLocalDate = input<string | null>(null);
  readonly dueDateSlot = input<DueDateSlotSelection | null>(null);
  readonly dueDateTimezone = input<string | null>(null);
  readonly completedAt = input<Date | string | null>(null);
  readonly archivedAt = input<Date | string | null>(null);
  readonly anchorPoint = input<{ x: number; y: number } | null>(null);
  readonly allowDuplicate = input<boolean>(true);
  readonly allowCopyToBoard = input<boolean>(true);
  readonly allowMoveToBoard = input<boolean>(true);
  readonly close = output<void>();
  readonly moved = output<void>();

  readonly duplicating = signal(false);
  readonly quickEditOpen = signal(false);
  readonly copyOpen = signal(false);
  readonly moveOpen = signal(false);
  readonly confirmingDelete = signal(false);
  readonly archiving = signal(false);
  readonly savingCompletion = signal(false);
  readonly savingWatch = signal(false);
  readonly isWatchingCard = computed(() => this.notifications.isWatchingCard(this.cardId()));
  readonly showCardWatchAction = computed(() => !this.notifications.isWatchingBoard(this.boardId()));
  readonly canMoveToBoard = computed(() => this.allowMoveToBoard() && this.state?.workspaceKind() !== "board");
  constructor() {
    this.panel.configure({
      // Two ways in: a right-click hands us a cursor point, the ⋯ button hands us its own element.
      // A point anchor gets no gap (the menu should open under the cursor, not beside it), which the
      // primitive already handles.
      anchor: () => this.anchorPoint(),
      // minHeight matches the menu's real height, so a menu with room for itself does not flip up.
      placement: () => ({ align: "end", width: 220, gap: 4, minHeight: 200 }),
      onDismiss: () => this.close.emit(),
    });
  }

  toggleCopy(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.quickEditOpen.set(false);
    this.moveOpen.set(false);
    this.copyOpen.update((v) => !v);
  }

  toggleMove(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.quickEditOpen.set(false);
    this.copyOpen.set(false);
    this.moveOpen.update((v) => !v);
  }

  toggleQuickEdit(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.copyOpen.set(false);
    this.moveOpen.set(false);
    this.quickEditOpen.update((v) => !v);
  }

  openInNewTab(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    window.open(this.cardUrl(), "_blank", "noopener");
    this.close.emit();
  }

  async copyCardLink(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    await navigator.clipboard?.writeText(new URL(this.cardUrl(), window.location.origin).toString()).catch(() => undefined);
    this.close.emit();
  }

  async copyCardKey(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const key = this.cardKey();
    if (key) await navigator.clipboard?.writeText(key).catch(() => undefined);
    this.close.emit();
  }

  async duplicate(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (this.duplicating()) return;
    this.duplicating.set(true);
    try {
      await this.api.post(`/cards/${this.cardId()}/duplicate`, {});
      this.close.emit();
    } finally {
      this.duplicating.set(false);
    }
  }

  async toggleCompletion(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (this.savingCompletion()) return;
    this.savingCompletion.set(true);
    try {
      const card = await this.api.patch<WireCard>(`/cards/${this.cardId()}/completion`, {
        completed: !this.completedAt(),
      });
      this.state?.updateCard(card);
      this.close.emit();
    } finally {
      this.savingCompletion.set(false);
    }
  }

  async toggleWatch(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (this.savingWatch()) return;
    this.savingWatch.set(true);
    try {
      await this.notifications.toggleCardWatch(this.cardId());
      this.close.emit();
    } finally {
      this.savingWatch.set(false);
    }
  }

  async onCopyPick(target: BoardPickerPick) {
    this.copyOpen.set(false);
    await this.api.post(`/cards/${this.cardId()}/duplicate`, { boardId: target.boardId, listId: target.listId });
    this.close.emit();
  }

  async onMovePick(target: BoardPickerPick) {
    this.moveOpen.set(false);
    await this.api.post(`/cards/${this.cardId()}/move-to-board`, { boardId: target.boardId });
    this.moved.emit();
    this.close.emit();
  }

  async setArchived(event: MouseEvent, archived: boolean) {
    event.preventDefault();
    event.stopPropagation();
    if (this.archiving()) return;
    this.archiving.set(true);
    try {
      const card = await this.api.patch<WireCard>(`/cards/${this.cardId()}/archive`, { archived });
      this.state?.updateCard(card);
      this.close.emit();
    } finally {
      this.archiving.set(false);
    }
  }

  private cardUrl(): string {
    const organisationKey = this.organisationKey();
    const cardKey = this.cardKey();
    if (organisationKey && cardKey) return cardPath(organisationKey, cardKey);
    // Deleted/legacy notification rows can lack a key; fall back to their board rather than
    // publishing another UUID-shaped card URL.
    const tree = this.router.createUrlTree(["/b", this.boardId()]);
    return this.router.serializeUrl(tree);
  }
}
