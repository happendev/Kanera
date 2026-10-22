import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import type { BoardTileSummary } from "@kanera/shared/dto";
import { icu } from "../core/i18n/icu";
import { AvatarComponent } from "./avatar.component";
import { formatDate, formatRelativeTime } from "./date-format";
import { TooltipDirective } from "./tooltip.directive";

/**
 * The quiet counts row under a board's name on a board tile: open and overdue counts, checklist
 * progress, the next due date, when the board last moved, and who is on it.
 *
 * Used by the workspace settings board list; written as a shared component so any other surface
 * that offers boards as tiles reads the same. Renders nothing until a summary arrives, so a tile is never
 * taller or shorter because the request is still in flight or failed. Only non-zero facts get a
 * chip: a board with no checklists or no due dates says nothing about them, and the row stays short.
 */
@Component({
  selector: "k-board-tile-summary",
  standalone: true,
  imports: [AvatarComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (summary(); as s) {
      <div class="bts-row">
        <span class="bts-stat">{{ openLabel() }}</span>
        @if (s.overdue > 0) {
          <span class="bts-stat is-danger"><i class="ti ti-alert-circle" aria-hidden="true"></i>{{ overdueLabel() }}</span>
        }
        @if (s.checklistTotal > 0) {
          <span class="bts-stat" kTooltip="Checklist items done on open cards" i18n-kTooltip="Board tile tooltip on the checklist count">
            <i class="ti ti-checkbox" aria-hidden="true"></i>
            <ng-container i18n="Board tile checklist progress, done out of total">{{ s.checklistDone // i18n(ph="done") }}/{{ s.checklistTotal // i18n(ph="total") }}</ng-container>
          </span>
        }
        @if (s.nextDueDate) {
          <span class="bts-stat" kTooltip="Next due date" i18n-kTooltip="Board tile tooltip on the next due date">
            <i class="ti ti-calendar" aria-hidden="true"></i>{{ nextDueLabel() }}
          </span>
        }
        @if (s.lastActivityAt) {
          <span class="bts-stat bts-updated">{{ updatedLabel() }}</span>
        }
        @if (s.members.length > 0) {
          <span class="bts-avatars">
            @for (member of s.members; track member.userId) {
              <k-avatar [url]="member.avatarUrl" [name]="member.displayName" [userId]="member.userId" [size]="20" />
            }
            @if (s.memberCount > s.members.length) {
              <span class="bts-more" [kTooltip]="moreMembersLabel()">+{{ s.memberCount - s.members.length }}</span>
            }
          </span>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
      }

      :host:empty {
        display: none;
      }

      .bts-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 4px 10px;
        min-width: 0;
        color: var(--text-3);
        font-size: var(--text-sm);
        font-weight: 500;
        line-height: 1.4;
        font-variant-numeric: tabular-nums;
      }

      .bts-stat {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
      }

      .bts-stat i {
        font-size: var(--text-md);
        line-height: 1;
        color: var(--text-muted);
      }

      .bts-stat.is-danger,
      .bts-stat.is-danger i {
        color: var(--danger);
      }

      .bts-updated {
        color: var(--text-muted);
        font-weight: 450;
      }

      /* Pushed to the end of the row; on a narrow tile the row wraps and the stack takes its own line. */
      .bts-avatars {
        display: inline-flex;
        align-items: center;
        margin-left: auto;
        padding-left: 4px;
      }

      /* The ring colour is the tile's own background; a host on a surface-2 row overrides it. */
      .bts-avatars k-avatar,
      .bts-more {
        box-shadow: 0 0 0 2px var(--bts-ring, var(--surface));
        border-radius: 50%;
      }

      .bts-avatars k-avatar + k-avatar,
      .bts-avatars k-avatar + .bts-more {
        margin-left: -6px;
      }

      /* Positioned so it paints over the avatar it overlaps; k-avatar hosts are positioned too, and
         an unpositioned badge would lose its "+" under the previous one. */
      .bts-more {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        background: var(--surface-2);
        color: var(--text-muted);
        font-size: var(--text-xs);
        font-weight: 600;
      }
    `,
  ],
})
export class BoardTileSummaryComponent {
  readonly summary = input<BoardTileSummary | null>(null);

  protected readonly openLabel = computed(() =>
    icu($localize`:Board tile count of open cards:{count, plural, =0 {No open cards} one {# open} other {# open}}`, { count: this.summary()?.open ?? 0 }));

  protected readonly overdueLabel = computed(() =>
    icu($localize`:Board tile count of overdue cards:{count, plural, one {# overdue} other {# overdue}}`, { count: this.summary()?.overdue ?? 0 }));

  protected readonly nextDueLabel = computed(() => {
    const date = this.summary()?.nextDueDate;
    return date ? formatDate(date, "short") : "";
  });

  protected readonly updatedLabel = computed(() => {
    const at = this.summary()?.lastActivityAt;
    return at ? $localize`:Board tile - when the board's cards last changed, e.g. "Updated 2h ago":Updated ${formatRelativeTime(at)}:time:` : "";
  });

  protected readonly moreMembersLabel = computed(() => {
    const s = this.summary();
    const count = s ? s.memberCount - s.members.length : 0;
    return icu($localize`:Board tile tooltip on the "+N" member overflow:{count, plural, one {# more member} other {# more members}}`, { count });
  });
}
