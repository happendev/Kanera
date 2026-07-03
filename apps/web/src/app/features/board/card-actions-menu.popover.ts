import type {
  AfterViewInit,
  OnDestroy
} from "@angular/core";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  HostListener,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import { Router } from "@angular/router";
import type { WireCard } from "@kanera/shared/events";
import { ApiClient } from "../../core/api/api.client";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { BoardPickerPopover } from "./board-picker.popover";
import { BoardState } from "./board-state";
import { CardQuickEditPopover } from "./card-quick-edit.popover";
import type { DueDateSlotSelection } from "./due-date.util";

@Component({
  selector: "k-card-actions-menu",
  standalone: true,
  imports: [BoardPickerPopover, CardQuickEditPopover],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cam-panel" (click)="$event.stopPropagation()">
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
              title="Copy to board"
              (pick)="onCopyPick($event)"
              (close)="copyOpen.set(false)"
            />
          }
        </div>
        }
        @if (allowMoveToBoard()) {
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
  styles: `
    :host {
      position: fixed;
      z-index: 300;
      visibility: hidden;
    }

    :host(.is-positioned) {
      visibility: visible;
    }

    .cam-panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
      padding: 4px;
      width: 220px;
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
})
export class CardActionsMenuPopover implements AfterViewInit, OnDestroy {
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly state = inject(BoardState, { optional: true });
  private readonly notifications = inject(NotificationsService);

  readonly cardId = input.required<string>();
  readonly boardId = input.required<string>();
  readonly workspaceId = input<string | null>(null);
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
  private anchorEl: HTMLElement | null = null;
  private readonly reposition = () => this.position();

  ngAfterViewInit() {
    this.anchorEl = this.hostEl.nativeElement.parentElement;
    this.position();
    window.addEventListener("resize", this.reposition);
    window.addEventListener("scroll", this.reposition, true);
  }

  ngOnDestroy() {
    window.removeEventListener("resize", this.reposition);
    window.removeEventListener("scroll", this.reposition, true);
  }

  private position() {
    const host = this.hostEl.nativeElement;
    const panelWidth = 220;
    const margin = 8;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const point = this.anchorPoint();
    const anchorRect = point ? null : this.anchorEl?.getBoundingClientRect();
    if (!point && !anchorRect) return;

    let left = point ? point.x : anchorRect!.right - panelWidth;
    if (left < margin) left = margin;
    if (left + panelWidth > viewportW - margin) left = viewportW - panelWidth - margin;

    const panelHeight = host.offsetHeight || 140;
    let top = point ? point.y : anchorRect!.bottom + 4;
    if (top + panelHeight > viewportH - margin) {
      const above = point ? point.y - panelHeight : anchorRect!.top - 4 - panelHeight;
      if (above >= margin) top = above;
      else top = Math.max(margin, viewportH - panelHeight - margin);
    }

    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
    host.classList.add("is-positioned");
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

  async onCopyPick(targetBoardId: string) {
    this.copyOpen.set(false);
    await this.api.post(`/cards/${this.cardId()}/duplicate`, { boardId: targetBoardId });
    this.close.emit();
  }

  async onMovePick(targetBoardId: string) {
    this.moveOpen.set(false);
    await this.api.post(`/cards/${this.cardId()}/move-to-board`, { boardId: targetBoardId });
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

  @HostListener("document:click")
  onDocumentClick() {
    this.close.emit();
  }

  private cardUrl(): string {
    const tree = this.router.createUrlTree(["/b", this.boardId()], { queryParams: { cardId: this.cardId() } });
    return this.router.serializeUrl(tree);
  }
}
