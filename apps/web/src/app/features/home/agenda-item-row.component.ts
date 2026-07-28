import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";
import type { HomeItem } from "@kanera/shared/dto";
import { CardLabelsComponent } from "../board/card-labels.component";
import { formatDueDate } from "../board/due-date.util";

/**
 * One agenda row: a card, or a checklist item shown with its parent card.
 *
 * Home-local rather than shared — the shape is home's DTO and nothing else renders it.
 */
@Component({
  selector: "k-agenda-item-row",
  standalone: true,
  imports: [CardLabelsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="agenda-row" (click)="activated.emit()">
      <span class="agenda-kind">
        <!--
          Match the app's established card/work icon vs a checklist. Deliberately NOT ti-checkbox:
          that glyph is a *ticked* box, which the app uses elsewhere to mean completed (see
          notifications-panel), and every row on this agenda is by definition still open.
        -->
        <i class="ti ti-{{ item().kind === 'checklistItem' ? 'list-check' : 'layout-kanban' }}"></i>
      </span>
      <span class="agenda-main">
        <span class="agenda-title">{{ item().title }}</span>
        @if (item().cardTitle; as parent) {
          <span class="agenda-parent">
            <i class="ti ti-corner-down-right" aria-hidden="true"></i>
            {{ parent }}
          </span>
        }
      </span>
      @if (item().labels.length > 0) {
        <!-- The board's own chip component, so labels look identical everywhere and inherit the
             shared compress/expand preference. -->
        <k-card-labels class="agenda-labels" [labels]="item().labels" />
      }
      <!-- The board is the primary context, so it gets its own chip carrying the board's own icon
           and colour rather than sharing a muted run-on line with the list name. -->
      <span class="agenda-board" [style.--board-color]="boardColor()">
        <i class="ti ti-{{ boardIcon() }}"></i>
        <span class="agenda-board-name">{{ item().boardName }}</span>
        @if (item().listName; as list) {
          <span class="agenda-list">{{ list }}</span>
        }
      </span>
      @if (item().guestOrganisationName; as org) {
        <span class="agenda-guest">{{ org }}</span>
      }
      <span class="agenda-due" [class.is-overdue]="item().bucket === 'overdue'">{{ dueText() }}</span>
    </button>
  `,
  styleUrl: "./agenda-item-row.component.scss",
})
export class AgendaItemRowComponent {
  readonly item = input.required<HomeItem>();

  readonly activated = output<void>();

  readonly boardIcon = computed(() => this.item().boardIcon || "layout-kanban");

  readonly boardColor = computed(() => {
    const token = this.item().boardIconColor;
    return token ? `var(--color-${token})` : "var(--text-muted)";
  });

  readonly dueText = computed(() => {
    const item = this.item();
    return formatDueDate(item.dueDateLocalDate, item.dueDateSlot, item.dueDateTimezone);
  });
}
