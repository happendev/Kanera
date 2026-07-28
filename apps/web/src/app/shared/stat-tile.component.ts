import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";

export type StatTileTone = "neutral" | "danger" | "success";

/**
 * A label-over-number stat tile, optionally acting as a jump target.
 *
 * Shared by the portfolio summary and home's focus tiles so the product has one visual language for
 * "a number worth clicking". Set `interactive` to false when a tile has nothing to activate — it
 * then renders as plain content with no hover arrow and no pointer, because a tile that invites a
 * click and does nothing is worse than one that never invited it.
 */
@Component({
  selector: "k-stat-tile",
  standalone: true,
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #body>
      <span class="stat-tile-label">
        @if (icon(); as iconName) {
          <i class="ti ti-{{ iconName }}"></i>
        }
        {{ label() }}
      </span>
      <strong>{{ value() }}</strong>
      @if (deltaLabel(); as delta) {
        <span class="stat-tile-delta" [class.is-up]="isUp()">
          <i class="ti ti-{{ deltaIcon() }}"></i>
          {{ delta }}
        </span>
      } @else if (interactive()) {
        <i class="ti ti-{{ active() ? 'x' : 'arrow-narrow-right' }} stat-tile-go"></i>
      }
    </ng-template>

    @if (interactive()) {
      <button
        type="button"
        class="stat-tile"
        [class.danger]="tone() === 'danger'"
        [class.success]="tone() === 'success'"
        [class.is-active]="active()"
        [attr.aria-pressed]="pressable() ? active() : null"
        (click)="activated.emit()"
      >
        <ng-container [ngTemplateOutlet]="body" />
      </button>
    } @else {
      <div
        class="stat-tile is-static"
        [class.danger]="tone() === 'danger'"
        [class.success]="tone() === 'success'"
      >
        <ng-container [ngTemplateOutlet]="body" />
      </div>
    }
  `,
  styleUrl: "./stat-tile.component.scss",
})
export class StatTileComponent {
  readonly label = input.required<string>();
  readonly value = input.required<number | string>();
  readonly icon = input<string | null>(null);
  readonly tone = input<StatTileTone>("neutral");
  /** When false the tile renders as static content — no button, no hover affordance. */
  readonly interactive = input(true);
  /** Renders the tile as an engaged toggle (used by home's agenda filters). */
  readonly active = input(false);
  /** Set when activating toggles a state, so the tile reports `aria-pressed`. */
  readonly pressable = input(false);
  /**
   * Optional change pill, e.g. "+4 vs last week". Replaces the hover arrow when present — a tile
   * cannot usefully show both a persistent pill and a hover affordance in the same slot.
   */
  readonly delta = input<number | null>(null);
  readonly deltaSuffix = input("vs last week");

  readonly activated = output<void>();

  readonly isUp = computed(() => (this.delta() ?? 0) > 0);

  readonly deltaIcon = computed(() => {
    const delta = this.delta() ?? 0;
    if (delta > 0) return "trending-up";
    if (delta < 0) return "trending-down";
    return "minus";
  });

  readonly deltaLabel = computed(() => {
    const delta = this.delta();
    if (delta === null) return null;
    const sign = delta > 0 ? "+" : "";
    return `${sign}${delta} ${this.deltaSuffix()}`;
  });
}
