import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { CardKeyDisplayService } from "../../shared/card-key-display.service";
import { addDays } from "../../shared/day-key.util";
import { formatDateTime, formatTime } from "../../shared/date-format";
import { ToastService } from "../../shared/toast.service";
import { TooltipDirective } from "../../shared/tooltip.directive";

/** Rows shown before "Show all": the head of the list, like Up next above it. */
const VISIBLE_LIMIT = 5;

/**
 * The viewer's pending card reminders, soonest first.
 *
 * Reminders are often on cards the viewer does not own (chasing someone else's work), so this is a
 * list on Home rather than a filter on My Cards, which only holds assigned work. It reads the
 * notifications service's live reminder state, so a reminder set, cleared or fired in another tab,
 * by an agent or by completing the card updates here without a reload.
 */
@Component({
  selector: "k-upcoming-reminders",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (reminders().length > 0) {
    <section class="reminders-section" aria-labelledby="home-reminders-heading">
      <h2 class="section-title" id="home-reminders-heading">
        <ng-container i18n="Section heading on the home page">Reminders</ng-container>
        <span class="reminders-count">{{ reminders().length }}</span>
      </h2>
      <div class="reminders-panel">
        @for (row of visible(); track row.id) {
        <div class="reminder-row">
          <button type="button" class="reminder-open" (click)="open(row)">
            <span class="reminder-icon"><i class="ti ti-alarm"></i></span>
            <span class="reminder-main">
              <span class="reminder-title">
                {{ row.card.title }}
                @if (showCardKeys()) { <span class="reminder-key">{{ row.card.key }}</span> }
              </span>
              @if (boardFor(row.card.boardId); as board) {
              <span class="reminder-board" [style.--board-color]="board.iconColor ? 'var(--color-' + board.iconColor + ')' : 'var(--text-muted)'">
                <i class="ti ti-{{ board.icon || 'layout-kanban' }}"></i>
                <span>{{ board.name }}</span>
              </span>
              }
            </span>
            <span class="reminder-when">{{ when(row.remindAt) }}</span>
          </button>
          <button type="button" class="reminder-clear" (click)="clear(row.cardId)" [disabled]="clearing() === row.cardId"
            aria-label="Clear reminder" i18n-aria-label="Button: clear the card reminder" kTooltip="Clear reminder" i18n-kTooltip="Button: clear the card reminder">
            <i class="ti ti-x"></i>
          </button>
        </div>
        }
        @if (reminders().length > limit) {
        <button type="button" class="reminders-more" (click)="expanded.update((open) => !open)">
          @if (expanded()) {
          <ng-container i18n="Button: collapse the reminders list">Show fewer</ng-container>
          } @else {
          <ng-container i18n="Button: show every reminder">Show all {{ reminders().length // i18n(ph="count") }}</ng-container>
          }
        </button>
        }
      </div>
    </section>
    }
  `,
  styles: `
    /* No box of its own: with no reminders it must not add a gap between Home's sections. */
    :host { display: contents; }

    .section-title {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 10px;
      color: var(--text);
      font-size: 15px;
      font-weight: 650;
      letter-spacing: var(--tracking-tight);
    }

    .reminders-count {
      min-width: 20px;
      padding: 1px 7px;
      border-radius: 999px;
      background: var(--surface-2);
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 600;
      text-align: center;
    }

    .reminders-panel {
      display: grid;
      gap: 2px;
      padding: 6px 4px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
    }

    .reminder-row {
      display: flex;
      align-items: center;
      gap: 2px;
      min-width: 0;
      border-radius: var(--radius);

      &:hover { background: var(--surface-hover); }
    }

    .reminder-open {
      /* The global button reset pins buttons to 36px with an accent fill; a row is neither. */
      flex: 1;
      min-width: 0;
      height: auto;
      min-height: 44px;
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      padding: 6px 8px 6px 12px;
      border: 0;
      border-radius: var(--radius);
      background: transparent;
      color: var(--text);
      text-align: left;
      cursor: pointer;

      &:hover:not(:disabled) { background: transparent; }

      &:focus-visible {
        outline: 2px solid var(--border-strong);
        outline-offset: -2px;
      }
    }

    .reminder-icon {
      display: flex;
      justify-content: center;
      color: var(--accent);
      font-size: 15px;
    }

    .reminder-main {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .reminder-title {
      min-width: 0;
      overflow: hidden;
      font-size: 13px;
      font-weight: 550;
      line-height: 1.35;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .reminder-key {
      margin-left: 4px;
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 500;
    }

    .reminder-board {
      flex: none;
      max-width: 40%;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--text-muted);
      font-size: 12px;

      i { color: var(--board-color); font-size: 14px; }
      span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    }

    .reminder-when {
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }

    .reminder-clear {
      flex: none;
      width: 32px;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-right: 4px;
      padding: 0;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;

      &:hover:not(:disabled) {
        background: var(--surface-2);
        color: var(--text);
      }
    }

    .reminders-more {
      justify-self: start;
      height: 32px;
      margin: 2px 8px 2px 44px;
      padding: 0 10px;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;

      &:hover:not(:disabled) {
        background: var(--surface-2);
        color: var(--text);
      }
    }

    /* A phone has no room beside the title: give it the whole first line, with the board and the
       time sharing the second. */
    @media (max-width: 640px) {
      .reminder-open {
        grid-template-columns: 22px minmax(0, 1fr) auto;
        grid-template-areas:
          "icon title title"
          "icon board when";
        row-gap: 2px;
      }

      .reminder-main { display: contents; }
      .reminder-icon { grid-area: icon; align-self: start; padding-top: 2px; }
      /* Wrap like the agenda rows below rather than cutting the title to a few characters. */
      .reminder-title {
        grid-area: title;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        white-space: normal;
      }
      .reminder-board { grid-area: board; max-width: 100%; min-width: 0; }
      .reminder-when { grid-area: when; }
    }

    @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
      .reminder-clear { width: 44px; height: 44px; }
    }
  `,
})
export class UpcomingRemindersComponent {
  private readonly notifications = inject(NotificationsService);
  private readonly workspaces = inject(WorkspaceService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly showCardKeys = inject(CardKeyDisplayService).showCardKeys;

  readonly limit = VISIBLE_LIMIT;
  readonly expanded = signal(false);
  readonly clearing = signal<string | null>(null);
  readonly reminders = this.notifications.upcomingReminders;
  readonly visible = computed(() => (this.expanded() ? this.reminders() : this.reminders().slice(0, VISIBLE_LIMIT)));
  private readonly boardsById = computed(() => new Map(this.workspaces.boards().map((board) => [board.id, board])));

  boardFor(boardId: string) {
    return this.boardsById().get(boardId) ?? null;
  }

  when(remindAt: string): string {
    const date = new Date(remindAt);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return $localize`:Reminder time later today:Today, ${formatTime(date)}:time:`;
    if (date.toDateString() === addDays(today, 1).toDateString()) return $localize`:Reminder time tomorrow:Tomorrow, ${formatTime(date)}:time:`;
    return formatDateTime(date, "weekday");
  }

  open(row: { cardId: string; card: { boardId: string; url: string } }): void {
    void this.router.navigate(["/b", row.card.boardId, "c", row.cardId], { browserUrl: new URL(row.card.url).pathname });
  }

  async clear(cardId: string): Promise<void> {
    if (this.clearing()) return;
    this.clearing.set(cardId);
    try {
      await this.notifications.clearCardReminder(cardId);
    } catch {
      this.toasts.error($localize`:Toast when clearing a reminder failed:Couldn't clear the reminder. Try again.`);
    } finally {
      this.clearing.set(null);
    }
  }
}
