import { CompletionWarningService } from "../../shared/completion-warning.service";
import { MenuDirective } from "../../shared/menu.directive";
import { ToastService } from "../../shared/toast.service";
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
import { ReminderPopoverComponent } from "./reminder-popover.component";
import { CardRelationsPopoverComponent } from "./card-relations-popover.component";
import type { DueDateSlotSelection } from "./due-date.util";

@Component({
  selector: "k-card-actions-menu",
  standalone: true,
  imports: [MenuDirective, BoardPickerPopover, CardQuickEditPopover, ReminderPopoverComponent, CardRelationsPopoverComponent],
  hostDirectives: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div kMenu class="cam-panel">
      <button type="button" class="k-menu-item cam-item" (click)="openInNewTab($event)">
        <i class="ti ti-external-link"></i>
        <span i18n>Open in new tab</span>
      </button>
      <div class="cam-sep" role="separator"></div>
      <div class="cam-sub">
        <button type="button" class="k-menu-item cam-item" [class.is-active]="quickEditOpen()" (click)="toggleQuickEdit($event)">
          <i class="ti ti-pencil"></i>
          <span i18n="Card menu item">Quick edit…</span>
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
      <!-- Directly under Quick edit: finishing a card is the most-used verb in this menu, and it
           belongs with the two that change the card rather than below the two that copy or follow
           it. -->
      <button type="button" class="k-menu-item cam-item" (click)="toggleCompletion($event)" [disabled]="savingCompletion()">
        <i [class]="completedAt() ? 'ti ti-circle' : 'ti ti-circle-check'"></i>
        @if (completedAt()) {
        <span i18n="Card menu item">Mark incomplete</span>
        } @else {
        <span i18n="Card menu item">Mark complete</span>
        }
      </button>
      <!-- Groups: open, change, follow, copy/move, share, archive. -->
      @if (showCardWatchAction() || !archivedAt()) {
        <div class="cam-sep" role="separator"></div>
      }
      @if (showCardWatchAction()) {
      <button type="button" class="k-menu-item cam-item" (click)="toggleWatch($event)" [disabled]="savingWatch()">
        <i [class]="isWatchingCard() ? 'ti ti-eye-off' : 'ti ti-eye'"></i>
        @if (isWatchingCard()) {
        <span i18n="Card menu item">Stop watching</span>
        } @else {
        <span i18n="Card menu item">Watch card</span>
        }
      </button>
      }
      <!-- A reminder on an archived card would fire silently, so the menu does not offer one. -->
      @if (!archivedAt()) {
      <div class="cam-sub">
        <button type="button" class="k-menu-item cam-item" [class.is-active]="reminderOpen()" (click)="toggleReminder($event)">
          <i class="ti ti-alarm"></i>
          @if (hasPendingReminder()) {
          <span i18n="Card menu item">Change reminder…</span>
          } @else {
          <span i18n="Card menu item">Remind me…</span>
          }
          <i class="ti ti-chevron-right cam-chev"></i>
        </button>
        @if (reminderOpen()) {
          <!-- Beside the row like Quick edit; closing it (or saving) closes the whole menu. -->
          <k-reminder-popover
            [cardId]="cardId()"
            [panelPlacement]="{ side: 'right', align: 'start', gap: 4 }"
            (dismissed)="close.emit()"
          />
        }
      </div>
      }
      <!-- Archived cards are read-only, and relations to or from them are refused. -->
      @if (!archivedAt()) {
      <div class="cam-sub">
        <button type="button" class="k-menu-item cam-item" [class.is-active]="relationsOpen()" (click)="toggleRelations($event)">
          <i class="ti ti-git-merge"></i>
          <span i18n="Card menu item: set what blocks this card, what it blocks and related cards">Dependencies…</span>
          <i class="ti ti-chevron-right cam-chev"></i>
        </button>
        @if (relationsOpen()) {
          <k-card-relations-popover
            [cardId]="cardId()"
            [workspaceId]="workspaceId()"
            [canEdit]="canEditRelations()"
            [panelPlacement]="{ side: 'right', align: 'start', gap: 4 }"
            (dismissed)="close.emit()"
          />
        }
      </div>
      }
      @if (allowDuplicate() || (workspaceId() && (allowCopyToBoard() || canMoveToBoard()))) {
        <div class="cam-sep" role="separator"></div>
      }
      @if (allowDuplicate()) {
      <button type="button" class="k-menu-item cam-item" (click)="duplicate($event)" [disabled]="duplicating()">
        <i class="ti ti-copy"></i>
        <span i18n="Card menu item">Duplicate card</span>
      </button>
      }
      @if (workspaceId()) {
        @if (allowCopyToBoard()) {
        <div class="cam-sub">
          <button type="button" class="k-menu-item cam-item" [class.is-active]="copyOpen()" (click)="toggleCopy($event)">
            <i class="ti ti-copy-plus"></i>
            <span i18n="Card menu item">Copy to board…</span>
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
              i18n-title
              (pick)="onCopyPick($event)"
              (close)="copyOpen.set(false)"
            />
          }
        </div>
        }
        @if (canMoveToBoard()) {
        <div class="cam-sub">
          <button type="button" class="k-menu-item cam-item" [class.is-active]="moveOpen()" (click)="toggleMove($event)">
            <i class="ti ti-arrow-right"></i>
            <span i18n="Card menu item">Move to board…</span>
            <i class="ti ti-chevron-right cam-chev"></i>
          </button>
          @if (moveOpen()) {
            <k-board-picker
              [sourceBoardId]="boardId()"
              [excludeBoardId]="boardId()"
              title="Move to board"
              i18n-title
              (pick)="onMovePick($event)"
              (close)="moveOpen.set(false)"
            />
          }
        </div>
        }
      }
      <div class="cam-sep" role="separator"></div>
      <button type="button" class="k-menu-item cam-item" (click)="copyCardLink($event)">
        <i class="ti ti-link"></i>
        <span i18n="Card menu item">Copy card link</span>
      </button>
      @if (cardKey()) {
      <button type="button" class="k-menu-item cam-item" (click)="copyCardKey($event)">
        <i class="ti ti-hash"></i>
        <span i18n="Card menu item: copy the card's short key, such as DEV-12">Copy key</span>
      </button>
      }
      <div class="cam-sep" role="separator"></div>
      @if (archivedAt()) {
        <button type="button" class="k-menu-item cam-item" (click)="setArchived($event, false)" [disabled]="archiving()">
          <i class="ti ti-archive-off"></i>
          <span i18n="Card menu item">Unarchive card</span>
        </button>
      } @else if (confirmingDelete()) {
        <div class="cam-confirm">
          <span class="cam-confirm-label" i18n>Archive this card?</span>
          <button type="button" class="cam-confirm-yes" (click)="setArchived($event, true)" [disabled]="archiving()" i18n="Button: confirm archiving the card">Archive</button>
          <button type="button" class="cam-confirm-cancel" (click)="$event.preventDefault(); $event.stopPropagation(); confirmingDelete.set(false)" i18n>Cancel</button>
        </div>
      } @else {
        <button type="button" class="k-menu-item cam-item danger" (click)="$event.preventDefault(); $event.stopPropagation(); confirmingDelete.set(true)">
          <i class="ti ti-archive"></i>
          <span i18n="Card menu item">Archive card</span>
        </button>
      }
    </div>
  `,
  styles: [
    ANCHORED_HOST_STYLES,
    `
    .cam-panel {
      background: var(--surface-overlay);
      border: 1px solid var(--overlay-border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-lg);
      padding: 4px;
      width: 100%;
      max-height: var(--ap-max-height, 640px);
      overflow-y: auto;
      overscroll-behavior: contain;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .cam-sub {
      position: relative;
    }

    

    .cam-sep {
      flex: none;
      height: 1px;
      background: var(--border-strong);
      margin: 5px -4px;
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
      background: var(--danger);
      color: var(--accent-fg);
      transition: opacity 0.1s;
      flex: 0 0 auto;

      &:hover:not(:disabled),
      &:active:not(:disabled) {
        background: var(--danger);
        opacity: 0.9;
      }

      &:focus-visible {
        box-shadow: 0 0 0 2px var(--surface-overlay), 0 0 0 4px var(--danger);
      }

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

      &:hover:not(:disabled),
      &:active:not(:disabled) {
        background: var(--surface-hover);
        color: var(--text);
      }
    }
  `,
  ],
})
export class CardActionsMenuPopover {
  private readonly panel = inject(AnchoredPanelDirective);
  private readonly toasts = inject(ToastService);
  private readonly api = inject(ApiClient);
  private readonly completionWarning = inject(CompletionWarningService);
  private readonly router = inject(Router);
  protected readonly state = inject(BoardState, { optional: true });
  /**
   * Whether the viewer may edit this card, from a host that knows (the notifications panel has each
   * row's board role). The board's own hosts leave it null and the route-scoped BoardState answers;
   * a BoardState that happens to be in scope for another board (the notifications panel over a
   * board) is not consulted. With neither, the menu offers the edit and the server has the last word.
   */
  readonly canEditCard = input<boolean | null>(null);
  readonly canEditRelations = computed(() => this.canEditCard() ?? (this.state ? this.state.canEdit() : true));
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
  readonly reminderOpen = signal(false);
  readonly relationsOpen = signal(false);
  readonly hasPendingReminder = computed(() => {
    const reminder = this.notifications.reminderFor(this.cardId());
    return Boolean(reminder && !reminder.firedAt);
  });
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
      // minHeight is about the full menu's height, so it flips up rather than scrolling when there
      // is more room above; maxHeight is above it so the menu only scrolls when the viewport is short.
      placement: () => ({ align: "end", width: 220, gap: 4, minHeight: 480, maxHeight: 640 }),
      onDismiss: () => this.close.emit(),
    });
  }

  toggleRelations(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.quickEditOpen.set(false);
    this.copyOpen.set(false);
    this.moveOpen.set(false);
    this.reminderOpen.set(false);
    this.relationsOpen.update((v) => !v);
  }

  toggleReminder(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.relationsOpen.set(false);
    this.quickEditOpen.set(false);
    this.copyOpen.set(false);
    this.moveOpen.set(false);
    this.reminderOpen.update((v) => !v);
  }

  toggleCopy(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.relationsOpen.set(false);
    this.quickEditOpen.set(false);
    this.moveOpen.set(false);
    this.reminderOpen.set(false);
    this.copyOpen.update((v) => !v);
  }

  toggleMove(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.relationsOpen.set(false);
    this.quickEditOpen.set(false);
    this.copyOpen.set(false);
    this.reminderOpen.set(false);
    this.moveOpen.update((v) => !v);
  }

  toggleQuickEdit(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.relationsOpen.set(false);
    this.copyOpen.set(false);
    this.moveOpen.set(false);
    this.reminderOpen.set(false);
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
      this.toasts.success($localize`Card duplicated.`, "copy");
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
      if (!await this.completionWarning.allow(!this.completedAt(), { cardIds: [this.cardId()] })) return;
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
      this.toasts.success($localize`Card copied to the selected board.`, "copy-plus");
    this.close.emit();
  }

  async onMovePick(target: BoardPickerPick) {
    this.moveOpen.set(false);
    await this.api.post(`/cards/${this.cardId()}/move-to-board`, { boardId: target.boardId });
    this.toasts.success($localize`Card moved to the selected board.`, "arrow-right");
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
      // Archive commits immediately (other clients see it via realtime) and Undo issues the reverse
      // PATCH, so there is nothing to confirm up front. The closure outlives this popover on purpose.
      if (archived) {
        const cardId = this.cardId();
        this.toasts.undoable({
          message: $localize`Card archived.`,
          icon: "archive",
          undo: async () => {
            const restored = await this.api.patch<WireCard>(`/cards/${cardId}/archive`, { archived: false });
            this.state?.updateCard(restored);
          },
        });
      } else {
        this.toasts.success($localize`Card restored.`, "archive-off");
      }
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
