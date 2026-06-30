import type {
  AfterViewInit,
  OnDestroy,
  OnInit,
} from "@angular/core";
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  computed,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import type { WireCard } from "@kanera/shared/events";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { AvatarComponent } from "../../shared/avatar.component";
import { BoardState } from "./board-state";
import { DatePickerPopover } from "./date-picker.popover";
import { dueDateInputValue, dueDateSlotFor, formatDueDate, type DueDateSlotSelection } from "./due-date.util";

@Component({
  selector: "k-card-quick-edit",
  standalone: true,
  imports: [AvatarComponent, DatePickerPopover],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cqe-panel" (click)="$event.stopPropagation()" (keydown.escape)="close.emit()">
      <div class="cqe-head">
        <span>Quick edit</span>
      </div>

      <label class="cqe-field">
        <span class="cqe-label">Title</span>
        <textarea
          #titleInput
          class="cqe-title-input"
          rows="1"
          [value]="draftTitle()"
          (input)="onTitleInput($any($event.target))"
          (blur)="saveTitle()"
          (keydown.enter)="saveTitle(); $event.preventDefault(); $any($event.target).blur()"
        ></textarea>
      </label>

      <div class="cqe-section">
        <span class="cqe-label">Members</span>
        <div class="cqe-list">
          @if (sortedMembers().length === 0) {
            <p class="cqe-empty">No members</p>
          }
          @for (member of sortedMembers(); track member.userId) {
            <button type="button" class="cqe-row" [class.is-selected]="assigneeIds().includes(member.userId)" (click)="$event.preventDefault(); $event.stopPropagation(); toggleAssignee(member.userId)">
              <k-avatar [url]="member.avatarUrl" [name]="member.displayName" [size]="22" [userId]="member.userId" />
              <span>{{ member.userId === currentUserId() ? 'Me' : member.displayName }}</span>
              @if (assigneeIds().includes(member.userId)) {
                <i class="ti ti-check"></i>
              }
            </button>
          }
        </div>
      </div>

      <div class="cqe-section">
        <span class="cqe-label">Labels</span>
        <div class="cqe-list">
          @if (sortedLabels().length === 0) {
            <p class="cqe-empty">No labels</p>
          }
          @for (label of sortedLabels(); track label.id) {
            <button type="button" class="cqe-row" [class.is-selected]="labelIds().includes(label.id)" (click)="$event.preventDefault(); $event.stopPropagation(); toggleLabel(label.id)">
              <span class="cqe-dot" [style.background]="label.color ? 'var(--color-' + label.color + ')' : 'var(--border-strong)'"></span>
              <span>{{ label.name }}</span>
              @if (labelIds().includes(label.id)) {
                <i class="ti ti-check"></i>
              }
            </button>
          }
        </div>
      </div>

      <div class="cqe-section cqe-due-wrap">
        <span class="cqe-label">Due date</span>
        <button type="button" class="cqe-due-btn" [class.is-active]="datePickerOpen()" (click)="$event.preventDefault(); toggleDatePicker($event)">
          <i class="ti ti-calendar-event"></i>
          <span>{{ dueDateText() }}</span>
        </button>
        @if (datePickerOpen()) {
          <k-date-picker
            [value]="dueDateInputValue()"
            [slot]="dueDateSlot()"
            (applyDate)="setDueDate($event.value, $event.slot)"
            (clear)="setDueDate('', 'anyTime')"
            (close)="datePickerOpen.set(false)"
          />
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      position: fixed;
      z-index: 301;
      visibility: hidden;
    }

    :host(.is-positioned) {
      visibility: visible;
    }

    .cqe-panel {
      width: 292px;
      max-height: min(640px, calc(100vh - 16px));
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
      color: var(--text);
    }

    .cqe-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 2px 2px;
      font-size: 12px;
      font-weight: 700;
      color: var(--text);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .cqe-field,
    .cqe-section {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .cqe-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
    }

    .cqe-title-input {
      min-height: 32px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      color: var(--text);
      padding: 7px 8px;
      font-size: 13px;
      line-height: 1.35;
      outline: none;
      resize: none;
      overflow: hidden;

      &:focus {
        border-color: var(--accent, var(--text));
      }
    }

    .cqe-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 150px;
      overflow-y: auto;
    }

    .cqe-row,
    .cqe-due-btn {
      width: 100%;
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
    }

    .cqe-row {
      min-height: 32px;
      padding: 5px 8px;

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

    .cqe-due-wrap {
      position: relative;
    }

    .cqe-due-btn {
      height: 32px;
      padding: 0 8px;
      border: 1px solid var(--border);
      background: var(--surface-2);

      > i {
        color: var(--text-muted);
        font-size: 14px;
      }

      > span {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
      }

      &:hover,
      &.is-active {
        background: var(--surface-hover);
        border-color: var(--border-strong);
      }
    }
  `,
})
export class CardQuickEditPopover implements OnInit, AfterViewInit, OnDestroy {
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly state = inject(BoardState, { optional: true });

  readonly cardId = input.required<string>();
  readonly title = input.required<string>();
  readonly dueDateLocalDate = input<string | null>(null);
  readonly dueDateSlotValue = input<DueDateSlotSelection | null>(null);
  readonly dueDateTimezone = input<string | null>(null);
  readonly close = output<void>();

  readonly draftTitle = signal("");
  readonly datePickerOpen = signal(false);
  readonly currentUserId = computed(() => this.auth.user()?.id ?? null);
  readonly labelIds = computed(() => this.state?.labelIdsForCard(this.cardId()) ?? []);
  readonly assigneeIds = computed(() => this.state?.assigneeIdsForCard(this.cardId()) ?? []);
  readonly sortedLabels = computed(() => [...(this.state?.cardLabels() ?? [])].sort((a, b) => Number(a.position) - Number(b.position)));
  readonly sortedMembers = computed(() => {
    const meId = this.currentUserId();
    return (this.state?.assignableMembers() ?? []).filter((member) => member.role !== "observer").sort((a, b) => {
      if (a.userId === meId) return -1;
      if (b.userId === meId) return 1;
      return a.displayName.localeCompare(b.displayName);
    });
  });

  @ViewChild("titleInput")
  private readonly titleInput?: ElementRef<HTMLTextAreaElement>;

  private anchorEl: HTMLElement | null = null;
  private readonly reposition = () => this.position();

  ngOnInit() {
    this.draftTitle.set(this.title());
  }

  ngAfterViewInit() {
    this.anchorEl = this.hostEl.nativeElement.parentElement;
    this.resizeTitleInput();
    requestAnimationFrame(() => this.resizeTitleInput());
    this.position();
    window.addEventListener("resize", this.reposition);
    window.addEventListener("scroll", this.reposition, true);
  }

  ngOnDestroy() {
    window.removeEventListener("resize", this.reposition);
    window.removeEventListener("scroll", this.reposition, true);
  }

  async saveTitle() {
    const next = this.draftTitle().trim();
    if (!next) {
      this.draftTitle.set(this.title());
      return;
    }
    if (next === this.title()) return;
    const card = await this.api.patch<WireCard>(`/cards/${this.cardId()}`, { title: next });
    this.state?.updateCard(card);
  }

  onTitleInput(target: HTMLTextAreaElement) {
    this.draftTitle.set(target.value);
    this.resizeTitleInput(target);
  }

  async toggleLabel(labelId: string) {
    if (!this.state) return;
    const current = this.labelIds();
    const next = current.includes(labelId)
      ? current.filter((id) => id !== labelId)
      : [...current, labelId];
    this.state.setCardLabels(this.cardId(), next);
    try {
      await this.api.put(`/cards/${this.cardId()}/labels`, { labelIds: next });
    } catch (e) {
      this.state.setCardLabels(this.cardId(), current);
      throw e;
    }
  }

  async toggleAssignee(userId: string) {
    if (!this.state) return;
    const assignableIds = new Set(this.state.assignableMembers().filter((member) => member.role !== "observer").map((member) => member.userId));
    const current = this.assigneeIds().filter((id) => assignableIds.has(id));
    const next = current.includes(userId)
      ? current.filter((id) => id !== userId)
      : [...current, userId];
    this.state.setCardAssignees(this.cardId(), next);
    try {
      await this.api.put(`/cards/${this.cardId()}/assignees`, { userIds: next });
    } catch (e) {
      this.state.setCardAssignees(this.cardId(), current);
      throw e;
    }
  }

  async setDueDate(dateStr: string, slot: DueDateSlotSelection = "anyTime") {
    const dueDateLocalDate = dateStr || null;
    const card = await this.api.patch<WireCard>(`/cards/${this.cardId()}`, {
      dueDateLocalDate,
      dueDateSlot: dueDateLocalDate ? slot : null,
    });
    this.state?.updateCard(card);
    if (!dueDateLocalDate) this.datePickerOpen.set(false);
  }

  toggleDatePicker(event: MouseEvent) {
    event.stopPropagation();
    this.datePickerOpen.update((v) => !v);
  }

  dueDateInputValue(): string {
    return dueDateInputValue(this.dueDateLocalDate());
  }

  dueDateSlot(): DueDateSlotSelection {
    return dueDateSlotFor(this.dueDateSlotValue());
  }

  dueDateText(): string {
    return this.dueDateLocalDate()
      ? formatDueDate(this.dueDateLocalDate(), this.dueDateSlotValue(), this.dueDateTimezone())
      : "No due date";
  }

  private position() {
    if (!this.anchorEl) return;
    const host = this.hostEl.nativeElement;
    const rect = this.anchorEl.getBoundingClientRect();
    const panelWidth = 292;
    const margin = 8;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let left = rect.right + 4;
    if (left + panelWidth > viewportW - margin) left = rect.left - 4 - panelWidth;
    if (left < margin) left = Math.max(margin, viewportW - panelWidth - margin);

    const panelHeight = host.offsetHeight || 520;
    let top = rect.top;
    if (top + panelHeight > viewportH - margin) top = viewportH - panelHeight - margin;
    if (top < margin) top = margin;

    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
    host.classList.add("is-positioned");
  }

  private resizeTitleInput(input = this.titleInput?.nativeElement) {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
    this.position();
  }

  @HostListener("document:click")
  onDocumentClick() {
    this.close.emit();
  }
}
