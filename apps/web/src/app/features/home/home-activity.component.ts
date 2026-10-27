import { ChangeDetectionStrategy, Component, inject, input, output } from "@angular/core";
import type { HomeActivityItem, HomeActivityKind } from "@kanera/shared/dto";
import { MinuteClockService } from "../../shared/minute-clock.service";
import { AuthService } from "../../core/auth/auth.service";
import { BoardIconComponent } from "../../shared/board-icon.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { formatRelativeTime } from "../../shared/date-format";

/** One glyph per kind, so a run of rows can be scanned by what happened before it is read. */
const KIND_ICONS: Record<HomeActivityKind, string> = {
  created: "plus",
  moved: "arrow-right",
  completed: "circle-check",
  reopened: "arrow-back-up",
  commented: "message",
  assigned: "users",
  attached: "paperclip",
};

/**
 * The rows of home's "My recent activity" panel: what the viewer moved forward across their boards.
 *
 * Every row is the viewer's own action, so there is no name or avatar: just what happened, to which
 * card, over a meta line naming the board. The page owns the section and its heading.
 */
@Component({
  selector: "k-home-activity",
  standalone: true,
  imports: [BoardIconComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
        <div class="activity-panel">
          @for (item of items(); track item.id) {
            <button type="button" class="activity-row" (click)="opened.emit(item)">
              <span class="activity-icon is-{{ item.kind }}" aria-hidden="true"><i aria-hidden="true" class="ti ti-{{ icons[item.kind] }}"></i></span>
              <span class="activity-body">
                <span class="activity-text">
                  @switch (item.kind) {
                    @case ("created") {
                      <ng-container i18n="My recent activity row: the viewer created a card">Created <span class="activity-card">{{ item.card.title // i18n(ph="card") }}</span></ng-container>
                    }
                    @case ("moved") {
                      @if (item.list; as list) {
                        <ng-container i18n="My recent activity row: the viewer moved a card into a list">Moved <span class="activity-card">{{ item.card.title // i18n(ph="card") }}</span> to <span class="activity-list" [style.--list-color]="listColor(list.color)">{{ list.name // i18n(ph="list") }}</span></ng-container>
                      } @else {
                        <ng-container i18n="My recent activity row: the viewer moved a card">Moved <span class="activity-card">{{ item.card.title // i18n(ph="card") }}</span></ng-container>
                      }
                    }
                    @case ("completed") {
                      <ng-container i18n="My recent activity row: the viewer completed a card">Completed <span class="activity-card">{{ item.card.title // i18n(ph="card") }}</span></ng-container>
                    }
                    @case ("reopened") {
                      <ng-container i18n="My recent activity row: the viewer marked a completed card incomplete again">Reopened <span class="activity-card">{{ item.card.title // i18n(ph="card") }}</span></ng-container>
                    }
                    @case ("commented") {
                      <ng-container i18n="My recent activity row: the viewer commented on a card">Commented on <span class="activity-card">{{ item.card.title // i18n(ph="card") }}</span></ng-container>
                    }
                    @case ("assigned") {
                      <ng-container i18n="My recent activity row: the viewer changed who is assigned to a card">Changed the assignees of <span class="activity-card">{{ item.card.title // i18n(ph="card") }}</span></ng-container>
                    }
                    @case ("attached") {
                      <ng-container i18n="My recent activity row: the viewer attached a file to a card">Added a file to <span class="activity-card">{{ item.card.title // i18n(ph="card") }}</span></ng-container>
                    }
                  }
                </span>
                <span class="activity-meta">
                  <span class="activity-board">
                    <k-board-icon [icon]="item.board.icon" [color]="item.board.iconColor" [size]="16" />
                    <span class="activity-board-name">{{ item.board.name }}</span>
                  </span>
                  @if (item.viaAgent) {
                    <!-- Card detail's marker and tooltip, so an agent's work reads the same here. -->
                    <span class="via-agent" [kTooltip]="doneByAgentTooltip(item.agentName)"><i class="ti ti-sparkles" aria-hidden="true"></i>{{ viaAgentLabel(item.agentName) }}</span>
                  }
                </span>
              </span>
              <!-- Its own column, as in card activity: the meta line below can then wrap on a phone
                   without the time landing at the start of a line. -->
              <span class="activity-time">{{ relativeTime(item.createdAt) }}</span>
            </button>
          } @empty {
            <p class="activity-empty" i18n="My recent activity empty state">Nothing you did on your boards in the last two weeks.</p>
          }
        </div>
  `,
  styleUrl: "./home-activity.component.scss",
})
export class HomeActivityComponent {
  /** Re-renders the "5m ago" stamps as the minutes pass, without refetching. */
  private readonly clock = inject(MinuteClockService);
  private readonly auth = inject(AuthService);

  readonly items = input.required<HomeActivityItem[]>();
  readonly opened = output<HomeActivityItem>();

  protected readonly icons = KIND_ICONS;

  /** Same wording as card activity, so an agent's work reads the same everywhere. */
  viaAgentLabel(agentName: string | null): string {
    return agentName
      ? $localize`:Marks a comment or change made by an AI agent, e.g. "via Claude":via ${agentName}:agent:`
      : $localize`:Marks a comment or change made by an unnamed AI agent:via AI agent`;
  }

  doneByAgentTooltip(agentName: string | null): string {
    const personName = this.auth.user()?.displayName ?? "";
    return agentName
      ? $localize`:Tooltip on a change an AI agent made for a person:Done by ${agentName}:agent: on behalf of ${personName}:person:`
      : $localize`:Tooltip on a change an AI agent made for a person:Done by an AI agent on behalf of ${personName}:person:`;
  }

  listColor(token: string | null): string | null {
    return token ? `var(--color-${token})` : null;
  }

  relativeTime(createdAt: string): string {
    return formatRelativeTime(createdAt, { now: new Date(this.clock.now()) });
  }
}
