import type { AfterViewInit, OnDestroy } from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, input, output, signal } from "@angular/core";
import type { WireBoardMemberUser, WireCard, WireCardSummary, WireList } from "@kanera/shared/events";
import type { Card, CardLabel, List } from "@kanera/shared/schema";
import { ApiClient } from "../../core/api/api.client";
import { AvatarComponent } from "../../shared/avatar.component";
import { BoardState } from "./board-state";
import { cardIdBatchesByBoard, cardIdsByBoard } from "./bulk-card-batches.util";
import { DatePickerPopover } from "./date-picker.popover";
import type { DueDateSlotSelection } from "./due-date.util";

type AnyCard = Card | WireCard | WireCardSummary;
type AnyList = List | WireList;

@Component({
  selector: "k-bulk-card-actions-menu",
  standalone: true,
  imports: [AvatarComponent, DatePickerPopover],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bcam-panel" (click)="$event.stopPropagation()">
      <div class="bcam-head">
        <span>{{ selectedCount() }} selected</span>
        @if (selectedBoardCount() > 1) {
          <small>{{ selectedBoardCount() }} boards</small>
        }
      </div>

      <button type="button" class="bcam-item" (click)="setCompletion($event, true)" [disabled]="saving()">
        <i class="ti ti-circle-check"></i>
        <span>Mark complete</span>
      </button>
      <button type="button" class="bcam-item" (click)="setCompletion($event, false)" [disabled]="saving()">
        <i class="ti ti-circle"></i>
        <span>Mark incomplete</span>
      </button>

      <div class="bcam-sub">
        <button type="button" class="bcam-item" [class.is-active]="dateOpen()" (click)="toggleSub($event, 'date')">
          <i class="ti ti-calendar-event"></i>
          <span>Set due date...</span>
          <i class="ti ti-chevron-right bcam-chev"></i>
        </button>
        @if (dateOpen()) {
          <k-date-picker
            [value]="''"
            [slot]="'anyTime'"
            (applyDate)="setDueDate($event.value, $event.slot)"
            (clear)="setDueDate('', 'anyTime')"
            (close)="dateOpen.set(false)"
          />
        }
      </div>

      <div class="bcam-sub">
        <button type="button" class="bcam-item" [class.is-active]="labelsOpen()" (click)="toggleSub($event, 'labels')">
          <i class="ti ti-tag"></i>
          <span>Labels</span>
          <i class="ti ti-chevron-right bcam-chev"></i>
        </button>
        @if (labelsOpen()) {
          <div class="bcam-picker cqe-section">
            <span class="cqe-label">Labels</span>
            <div class="cqe-list">
            @for (label of sortedLabels(); track label.id) {
              <button type="button" class="cqe-row" [class.is-selected]="labelState(label.id) !== 'none'" (click)="toggleLabel(label.id)" [disabled]="saving()">
                <span class="cqe-dot" [style.background]="label.color ? 'var(--color-' + label.color + ')' : 'var(--border-strong)'"></span>
                <span>{{ label.name }}</span>
                @if (labelState(label.id) === 'all') {
                  <i class="ti ti-check"></i>
                } @else if (labelState(label.id) === 'mixed') {
                  <i class="ti ti-square-half"></i>
                }
              </button>
            } @empty {
              <p class="cqe-empty">No labels</p>
            }
            </div>
          </div>
        }
      </div>

      <div class="bcam-sub">
        <button type="button" class="bcam-item" [class.is-active]="membersOpen()" (click)="toggleSub($event, 'members')">
          <i class="ti ti-users"></i>
          <span>Assignees</span>
          <i class="ti ti-chevron-right bcam-chev"></i>
        </button>
        @if (membersOpen()) {
          <div class="bcam-picker cqe-section">
            <span class="cqe-label">Members</span>
            <div class="cqe-list">
            @for (member of assignableMembers(); track member.userId) {
              <button type="button" class="cqe-row" [class.is-selected]="assigneeState(member.userId) !== 'none'" (click)="toggleAssignee(member.userId)" [disabled]="saving()">
                <k-avatar [url]="member.avatarUrl" [name]="member.displayName" [size]="22" [userId]="member.userId" />
                <span>{{ member.userId === currentUserId() ? 'Me' : member.displayName }}</span>
                @if (assigneeState(member.userId) === 'all') {
                  <i class="ti ti-check"></i>
                } @else if (assigneeState(member.userId) === 'mixed') {
                  <i class="ti ti-square-half"></i>
                }
              </button>
            } @empty {
              <p class="cqe-empty">No members</p>
            }
            </div>
          </div>
        }
      </div>

      <div class="bcam-sub">
        <button type="button" class="bcam-item" [class.is-active]="listsOpen()" (click)="toggleSub($event, 'lists')">
          <i class="ti ti-arrows-transfer-down"></i>
          <span>Move to list</span>
          <i class="ti ti-chevron-right bcam-chev"></i>
        </button>
        @if (listsOpen()) {
          <div class="bcam-picker">
            @for (list of lists(); track list.id) {
              <button type="button" class="bcam-picker-row" (click)="moveToList(list.id)" [disabled]="saving()">
                <i [class]="'ti ti-' + (list.icon || 'list')" [style.color]="list.color ? 'var(--color-' + list.color + ')' : null"></i>
                <span>{{ list.name }}</span>
              </button>
            }
          </div>
        }
      </div>

      <button type="button" class="bcam-item" (click)="openCustomFields($event)" [disabled]="saving()">
        <i class="ti ti-forms"></i>
        <span>Custom fields...</span>
      </button>

      <button type="button" class="bcam-item" (click)="duplicate($event)" [disabled]="saving()">
        <i class="ti ti-copy"></i>
        <span>Copy cards</span>
      </button>

      <div class="bcam-sep"></div>
      @if (confirmArchive()) {
        <div class="bcam-confirm">
          <span>Archive selected?</span>
          <button type="button" class="bcam-confirm-yes" (click)="archive($event)" [disabled]="saving()">Archive</button>
          <button type="button" class="bcam-confirm-cancel" (click)="$event.stopPropagation(); confirmArchive.set(false)">Cancel</button>
        </div>
      } @else {
        <button type="button" class="bcam-item bcam-danger" (click)="$event.stopPropagation(); confirmArchive.set(true)" [disabled]="saving()">
          <i class="ti ti-archive"></i>
          <span>Archive cards</span>
        </button>
      }
    </div>
  `,
  styles: `
    :host {
      position: fixed;
      z-index: 320;
      visibility: hidden;
    }

    :host(.is-positioned) {
      visibility: visible;
    }

    .bcam-panel,
    .bcam-picker {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
      padding: 4px;
      width: 232px;
      display: flex;
      flex-direction: column;
      gap: 1px;
      color: var(--text);
    }

    .bcam-head {
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;

      small {
        display: block;
        margin-top: 2px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0;
        text-transform: none;
      }
    }

    .bcam-sub {
      position: relative;
    }

    .bcam-item,
    .bcam-picker-row {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: 32px;
      padding: 7px 10px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      color: var(--text);
      background: transparent;
      border: none;
      cursor: pointer;
      text-align: left;

      > i {
        width: 16px;
        flex: 0 0 16px;
        color: var(--text-muted);
      }

      > span {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      &:hover,
      &.is-active {
        background: var(--surface-hover);
      }

      &:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
    }

    .bcam-chev {
      margin-left: auto;
      font-size: 12px;
    }

    .bcam-picker {
      position: absolute;
      left: calc(100% + 4px);
      top: 0;
      max-height: min(340px, calc(100vh - 24px));
      overflow-y: auto;
    }

    :host(.submenu-opens-left) .bcam-picker {
      left: auto;
      right: calc(100% + 4px);
    }

    :host(.submenu-overlays) .bcam-picker {
      left: 0;
      right: auto;
    }

    .cqe-section {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px;
    }

    .cqe-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
    }

    .cqe-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 150px;
      overflow-y: auto;
    }

    .cqe-row {
      width: 100%;
      min-height: 32px;
      padding: 5px 8px;
      display: flex;
      align-items: center;
      gap: 8px;
      border: none;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text);
      cursor: pointer;
      text-align: left;
      transition: background-color 0.12s;

      > span:not(.cqe-dot) {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
      }

      > i {
        color: var(--accent, var(--text));
        font-size: 14px;
      }

      &:hover,
      &.is-selected {
        background: var(--surface-2);
      }

      &:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
    }

    .cqe-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex: 0 0 12px;
    }

    .cqe-empty {
      margin: 0;
      padding: 6px 8px;
      color: var(--text-muted);
      font-size: 12px;
    }

    .bcam-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex: 0 0 12px;
    }

    .bcam-empty {
      margin: 0;
      padding: 8px;
      color: var(--text-muted);
      font-size: 12px;
      text-align: center;
    }

    .bcam-sep {
      height: 1px;
      margin: 3px 0;
      background: var(--border);
    }

    .bcam-danger {
      color: var(--danger, #d33);

      > i {
        color: var(--danger, #d33);
      }
    }

    .bcam-confirm {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px;
      font-size: 12px;
      color: var(--text-muted);

      span {
        flex: 1;
      }
    }

    .bcam-confirm-yes,
    .bcam-confirm-cancel {
      border: none;
      border-radius: var(--radius-sm);
      padding: 4px 7px;
      cursor: pointer;
      font-size: 12px;
    }

    .bcam-confirm-yes {
      background: var(--danger, #d33);
      color: #fff;
    }

    .bcam-confirm-cancel {
      background: transparent;
      color: var(--text-muted);
    }
  `,
})
export class BulkCardActionsMenuPopover implements AfterViewInit, OnDestroy {
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly api = inject(ApiClient);
  private readonly state = inject(BoardState);

  readonly boardId = input.required<string>();
  readonly cardIds = input.required<string[]>();
  readonly cards = input.required<AnyCard[]>();
  readonly lists = input.required<AnyList[]>();
  readonly labels = input.required<CardLabel[]>();
  readonly members = input.required<WireBoardMemberUser[]>();
  readonly currentUserId = input<string | null | undefined>(null);
  readonly anchorPoint = input<{ x: number; y: number } | null>(null);
  readonly dismissed = output<void>();
  readonly done = output<void>();
  // Custom-field editing uses a dedicated dialog (too many editor types for this flyout),
  // so the menu only emits a request; the host page opens k-bulk-custom-fields-dialog.
  readonly editCustomFields = output<void>();

  readonly dateOpen = signal(false);
  readonly labelsOpen = signal(false);
  readonly membersOpen = signal(false);
  readonly listsOpen = signal(false);
  readonly confirmArchive = signal(false);
  readonly saving = signal(false);

  readonly selectedCount = computed(() => this.cardIds().length);
  readonly selectedBoardCount = computed(() => this.cardIdsByBoard().size);
  readonly sortedLabels = computed(() => [...this.labels()].sort((a, b) => Number(a.position) - Number(b.position)));
  readonly assignableMembers = computed(() => {
    const meId = this.currentUserId();
    return this.members().filter((member) => member.role !== "observer").sort((a, b) => {
      if (a.userId === meId) return -1;
      if (b.userId === meId) return 1;
      return a.displayName.localeCompare(b.displayName);
    });
  });

  private readonly reposition = () => this.position();

  ngAfterViewInit() {
    this.position();
    window.addEventListener("resize", this.reposition);
    window.addEventListener("scroll", this.reposition, true);
  }

  ngOnDestroy() {
    window.removeEventListener("resize", this.reposition);
    window.removeEventListener("scroll", this.reposition, true);
  }

  toggleSub(event: MouseEvent, sub: "date" | "labels" | "members" | "lists") {
    event.preventDefault();
    event.stopPropagation();
    this.dateOpen.set(sub === "date" ? !this.dateOpen() : false);
    this.labelsOpen.set(sub === "labels" ? !this.labelsOpen() : false);
    this.membersOpen.set(sub === "members" ? !this.membersOpen() : false);
    this.listsOpen.set(sub === "lists" ? !this.listsOpen() : false);
    this.confirmArchive.set(false);
  }

  labelState(labelId: string): "all" | "mixed" | "none" {
    const count = this.cardIds().filter((cardId) => this.state.labelIdsForCard(cardId).includes(labelId)).length;
    return count === 0 ? "none" : count === this.cardIds().length ? "all" : "mixed";
  }

  assigneeState(userId: string): "all" | "mixed" | "none" {
    const count = this.cardIds().filter((cardId) => this.state.assigneeIdsForCard(cardId).includes(userId)).length;
    return count === 0 ? "none" : count === this.cardIds().length ? "all" : "mixed";
  }

  async setCompletion(event: MouseEvent, completed: boolean) {
    event.preventDefault();
    event.stopPropagation();
    await this.run(async () => {
      for (const [boardId, cardIds] of this.cardIdBatchesByBoard()) {
        const result = await this.api.patch<{ cards: WireCard[] }>(`/boards/${boardId}/cards/bulk/completion`, { cardIds, completed });
        for (const card of result.cards ?? []) this.state.updateCard(card);
      }
    });
  }

  async setDueDate(value: string, slot: DueDateSlotSelection) {
    await this.run(async () => {
      const dueDateLocalDate = value || null;
      for (const [boardId, cardIds] of this.cardIdBatchesByBoard()) {
        const result = await this.api.patch<{ cards: WireCard[] }>(`/boards/${boardId}/cards/bulk/due-date`, {
          cardIds,
          dueDateLocalDate,
          dueDateSlot: dueDateLocalDate ? slot : null,
        });
        for (const card of result.cards ?? []) this.state.updateCard(card);
      }
    });
  }

  async toggleLabel(labelId: string) {
    const mode = this.labelState(labelId) === "all" ? "remove" : "add";
    await this.run(async () => {
      for (const cardId of this.cardIds()) {
        const current = this.state.labelIdsForCard(cardId);
        const next = mode === "add" ? Array.from(new Set([...current, labelId])) : current.filter((id) => id !== labelId);
        this.state.setCardLabels(cardId, next);
      }
      for (const [boardId, cardIds] of this.cardIdBatchesByBoard()) {
        await this.api.patch(`/boards/${boardId}/cards/bulk/labels`, { cardIds, mode, labelIds: [labelId] });
      }
    }, false);
  }

  async toggleAssignee(userId: string) {
    const mode = this.assigneeState(userId) === "all" ? "remove" : "add";
    await this.run(async () => {
      for (const cardId of this.cardIds()) {
        const current = this.state.assigneeIdsForCard(cardId);
        const next = mode === "add" ? Array.from(new Set([...current, userId])) : current.filter((id) => id !== userId);
        this.state.setCardAssignees(cardId, next);
      }
      for (const [boardId, cardIds] of this.cardIdBatchesByBoard()) {
        await this.api.patch(`/boards/${boardId}/cards/bulk/assignees`, { cardIds, mode, userIds: [userId] });
      }
    }, false);
  }

  async moveToList(listId: string) {
    await this.run(async () => {
      for (const [boardId, cardIds] of this.cardIdBatchesByBoard()) {
        const result = await this.api.post<{ cards: WireCard[] }>(`/boards/${boardId}/cards/bulk/move`, { cardIds, listId });
        for (const card of result.cards ?? []) this.state.moveCard(card.id, card.listId, card.position);
      }
    });
  }

  openCustomFields(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    // Hand off to the host page's dialog and close this flyout without clearing selection.
    this.editCustomFields.emit();
    this.dismissed.emit();
  }

  async duplicate(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    await this.run(async () => {
      for (const [boardId, cardIds] of this.cardIdBatchesByBoard()) {
        const result = await this.api.post<{ cards: WireCard[] }>(`/boards/${boardId}/cards/bulk/duplicate`, { cardIds });
        for (const card of result.cards ?? []) this.state.addCard(card);
      }
    });
  }

  async archive(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    await this.run(async () => {
      for (const [boardId, cardIds] of this.cardIdBatchesByBoard()) {
        const result = await this.api.patch<{ cards: WireCard[] }>(`/boards/${boardId}/cards/bulk/archive`, { cardIds, archived: true });
        for (const card of result.cards ?? []) this.state.updateCard(card);
      }
    });
  }

  @HostListener("document:click")
  onDocumentClick() {
    this.dismissed.emit();
  }

  private async run(fn: () => Promise<void>, closeAfter = true) {
    if (this.saving()) return;
    this.saving.set(true);
    try {
      await fn();
      if (closeAfter) {
        this.done.emit();
        this.dismissed.emit();
      }
    } finally {
      this.saving.set(false);
    }
  }

  private cardIdsByBoard(): Map<string, string[]> {
    return cardIdsByBoard(this.cardIds(), this.cards(), this.boardId());
  }

  private cardIdBatchesByBoard(): Array<[string, string[]]> {
    return cardIdBatchesByBoard(this.cardIds(), this.cards(), this.boardId());
  }

  private position() {
    const point = this.anchorPoint();
    if (!point) return;
    const host = this.hostEl.nativeElement;
    const panelWidth = 232;
    const margin = 8;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let left = point.x;
    if (left < margin) left = margin;
    if (left + panelWidth > viewportW - margin) left = viewportW - panelWidth - margin;

    const submenuWidth = 232;
    const submenuGap = 4;
    const roomRight = viewportW - margin - (left + panelWidth);
    const roomLeft = left - margin;
    const submenuFitsRight = roomRight >= submenuWidth + submenuGap;
    const submenuFitsLeft = roomLeft >= submenuWidth + submenuGap;
    // Submenus normally open to the right. Flip them at the viewport edge, and overlay
    // the parent on narrow screens where two full panels cannot fit side by side.
    host.classList.toggle("submenu-opens-left", !submenuFitsRight && submenuFitsLeft);
    host.classList.toggle("submenu-overlays", !submenuFitsRight && !submenuFitsLeft);

    const panelHeight = host.offsetHeight || 320;
    let top = point.y;
    if (top + panelHeight > viewportH - margin) top = Math.max(margin, viewportH - panelHeight - margin);

    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
    host.classList.add("is-positioned");
  }
}
