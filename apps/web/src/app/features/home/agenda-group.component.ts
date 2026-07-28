import { ChangeDetectionStrategy, Component, computed, input, output, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import type { HomeItem } from "@kanera/shared/dto";
import { AgendaItemRowComponent } from "./agenda-item-row.component";

/** Rows shown before the "Show N more" affordance appears. */
const COLLAPSED_LIMIT = 8;

/**
 * One bucket of the agenda, with its count badge and its own expansion state.
 *
 * A group is only rendered when it has items (`HomeState.groups()` filters empty ones out), so
 * this never has to render an empty heading.
 */
@Component({
  selector: "k-agenda-group",
  standalone: true,
  imports: [AgendaItemRowComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="agenda-group" [attr.data-bucket]="bucket()">
      <header class="agenda-group-header">
        <h3>{{ label() }}</h3>
        <span class="agenda-count" [class.is-danger]="bucket() === 'overdue'">{{ count() }}</span>
        @if (truncated()) {
          <!-- The server capped the merged list, so the rest genuinely is not here to expand. -->
          <a class="agenda-see-all" routerLink="/my-cards">See all <i class="ti ti-arrow-narrow-right"></i></a>
        }
      </header>
      <div class="agenda-rows">
        @for (item of visibleItems(); track item.id) {
          <k-agenda-item-row [item]="item" (activated)="itemActivated.emit(item)" />
        }
      </div>
      @if (hiddenCount() > 0) {
        <button type="button" class="agenda-more" (click)="expanded.set(true)">
          Show {{ hiddenCount() }} more
        </button>
      }
    </section>
  `,
  styleUrl: "./agenda-group.component.scss",
})
export class AgendaGroupComponent {
  readonly bucket = input.required<string>();
  readonly label = input.required<string>();
  readonly items = input.required<HomeItem[]>();
  /** Exact server count, which can exceed `items.length` when the horizon was capped. */
  readonly count = input.required<number>();

  readonly itemActivated = output<HomeItem>();

  readonly expanded = signal(false);

  readonly visibleItems = computed(() =>
    this.expanded() ? this.items() : this.items().slice(0, COLLAPSED_LIMIT));

  readonly hiddenCount = computed(() => Math.max(0, this.items().length - this.visibleItems().length));

  /** True when the server sent fewer rows than it counted, so expanding cannot reveal the rest. */
  readonly truncated = computed(() => this.count() > this.items().length);
}
