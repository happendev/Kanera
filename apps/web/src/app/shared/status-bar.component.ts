import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { TooltipDirective } from "./tooltip.directive";

/** One list (or any status bucket) in a segmented bar. `color` is a palette name (`sky`, `amber`). */
export interface StatusBarSegment {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  count: number;
}

/**
 * One bar split by list colour, with a legend of list icon, name and count.
 *
 * Shared by the board overview, the Portfolio summary and the Work done report so "where the open
 * work sits" has one shape everywhere: a single proportional bar for the gestalt, the legend for the
 * numbers. Lists without a colour step through a neutral ramp (one tone per uncoloured list, in
 * list order) rather than borrowing a palette hue: the segments stay tellable apart, but the bar
 * never implies a status colour the workspace did not choose. Most workspaces never colour their
 * lists, so without the ramp the bar would read as one flat block.
 */
/** Share of `--text-3` over `--border-strong` for each successive uncoloured list; cycles past six. */
const NEUTRAL_RAMP = [90, 70, 52, 36, 22, 10] as const;

@Component({
  selector: "k-status-bar",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (filled().length) {
      <div class="status-bar" role="img" [attr.aria-label]="summary()">
        @for (segment of filled(); track segment.id) {
          <span class="status-segment" [style.flex-grow]="segment.count" [style.background]="fills().get(segment.id)" [kTooltip]="segmentLabel(segment)"></span>
        }
      </div>
    }
    @if (legend()) {
      <ul class="status-legend" [class.is-grid]="legendLayout() === 'grid'">
        @for (segment of segments(); track segment.id) {
          <li [class.is-zero]="segment.count === 0">
            <i class="status-swatch" [style.background]="fills().get(segment.id)"></i>
            @if (segment.icon; as icon) {
              <i class="ti ti-{{ icon }}" aria-hidden="true"></i>
            }
            <span class="status-name">{{ segment.name }}</span>
            <strong>{{ segment.count }}</strong>
          </li>
        }
      </ul>
    }
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
    }

    .status-bar {
      display: flex;
      gap: 2px;
      height: 8px;
      border-radius: 4px;
      overflow: hidden;
    }

    .status-segment {
      display: block;
      flex: 0 1 0;
      min-width: 3px;
      transition: flex-grow var(--motion-base) var(--ease-out);
    }

    .status-legend {
      display: flex;
      flex-direction: column;
      gap: 1px;
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: var(--text-xs);
      color: var(--text-muted);

      li {
        display: flex;
        align-items: center;
        gap: 7px;
        min-height: 26px;
        min-width: 0;
      }

      li.is-zero {
        opacity: 0.6;
      }

      .ti {
        flex: none;
        font-size: var(--text-md);
      }

      .status-name {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      strong {
        flex: none;
        color: var(--text-3);
        font-variant-numeric: tabular-nums;
      }
    }

    /* Wide panels flow the legend into columns so eight lists do not stack into a tall column
       beside a one-line bar; each column still keeps the icon · name · count row shape. */
    .status-legend.is-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
      gap: 0 16px;
    }

    .status-swatch {
      flex: none;
      width: 8px;
      height: 8px;
      border-radius: 2px;
    }

    @media (prefers-reduced-motion: reduce) {
      .status-segment {
        transition: none;
      }
    }
  `],
})
export class StatusBarComponent {
  readonly segments = input.required<readonly StatusBarSegment[]>();
  /** Off when the host already lists the segments with their counts (the report's bar chart). */
  readonly legend = input(true);
  /** "list" stacks the legend rows; "grid" flows them into columns on wide panels. */
  readonly legendLayout = input<"list" | "grid">("list");

  readonly filled = computed(() => this.segments().filter((segment) => segment.count > 0));

  readonly summary = computed(() =>
    this.filled().map((segment) => this.segmentLabel(segment)).join(", "),
  );

  /**
   * Fill per segment id. Coloured lists use their palette token; uncoloured lists take successive
   * stops of a neutral ramp between the tertiary text tone and the strong border tone, mixed at use
   * so each theme resolves its own neutrals.
   */
  readonly fills = computed(() => {
    const fills = new Map<string, string>();
    let neutral = 0;
    for (const segment of this.segments()) {
      if (segment.color) {
        fills.set(segment.id, `var(--color-${segment.color})`);
      } else {
        const stop = NEUTRAL_RAMP[neutral % NEUTRAL_RAMP.length];
        neutral += 1;
        fills.set(segment.id, `color-mix(in srgb, var(--text-3) ${stop}%, var(--border-strong))`);
      }
    }
    return fills;
  });

  segmentLabel(segment: StatusBarSegment): string {
    return $localize`:Status bar segment - list name and its card count:${segment.name}:list: · ${segment.count}:count:`;
  }
}
