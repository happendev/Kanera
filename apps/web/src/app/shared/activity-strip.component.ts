import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";
import { TooltipDirective } from "./tooltip.directive";
import { addDays, localDateKey, parseDateKey } from "./day-key.util";

/** One metric to plot. Counts are keyed by local YYYY-MM-DD day; missing days render as zero. */
export interface ActivityStripSeries {
  key: string;
  label: string;
  /** Singular noun for the per-day tooltip, e.g. "move" reads as "3 moves · Wed, 22 Jul". */
  noun: string;
  tone: "accent" | "success";
  counts: ReadonlyMap<string, number>;
}

/** One day column. `weekStart` marks Mondays, which get a subtle separator. */
export interface ActivityStripCell {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  label: string;
  weekStart: boolean;
}

/**
 * Builds the day columns for one series, oldest first, ending on `endDate`.
 *
 * Levels are scaled to the busiest day *in this window* rather than an absolute threshold, so a quiet
 * workspace still shows contrast instead of one flat colour. Pure and exported for direct testing.
 */
export function buildActivityStripCells(
  series: ActivityStripSeries,
  windowDays: number,
  endDate: Date,
): ActivityStripCell[] {
  let peak = 0;
  for (const value of series.counts.values()) peak = Math.max(peak, value);

  const cells: ActivityStripCell[] = [];
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const day = addDays(endDate, -offset);
    const date = localDateKey(day);
    const count = series.counts.get(date) ?? 0;
    cells.push({
      date,
      count,
      level: count === 0 ? 0 : (Math.min(4, Math.ceil((count / Math.max(peak, 1)) * 4)) as 1 | 2 | 3 | 4),
      label: `${count} ${count === 1 ? series.noun : `${series.noun}s`} · ${day.toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
      })}`,
      // Monday starts a new week: a stronger left edge keeps the eye from losing its place across
      // dozens of otherwise undifferentiated columns.
      weekStart: day.getDay() === 1,
    });
  }
  return cells;
}

/**
 * Day-per-column activity strips: one column per calendar day, one row per metric.
 *
 * One column per day (rather than a GitHub week grid) is what lets a 60-day window span the panel's
 * width instead of huddling in a corner, and it stacks the metrics on the same day columns for a
 * direct read — a busy movement strip over an empty completion strip is the "lots of churn, nothing
 * shipped" signal these exist to surface.
 *
 * Shared by the portfolio summary and the work-done timeline so the product has exactly one visual
 * language for per-day activity.
 */
@Component({
  selector: "k-activity-strip",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="activity-panel">
      <header>
        <strong>{{ heading() }}</strong>
        <span>{{ windowLabel() }}</span>
        <div class="activity-legend">
          <span>Less</span>
          @for (level of legendLevels; track level) {
            <i class="activity-cell" [attr.data-level]="level"></i>
          }
          <span>More</span>
        </div>
      </header>
      <div class="activity-strips">
        <span class="activity-row-label"></span>
        <div class="activity-months" aria-hidden="true">
          @for (month of monthCells(); track $index) {
            <span>{{ month }}</span>
          }
        </div>
        @for (row of rows(); track row.key) {
          <div class="activity-row-label">
            <strong>{{ row.label }}</strong>
            <span>{{ row.total }} {{ row.total === 1 ? row.noun : row.noun + "s" }}</span>
          </div>
          <div class="activity-strip" [attr.data-tone]="row.tone">
            @for (cell of row.cells; track cell.date) {
              @if (selectable()) {
                <button
                  type="button"
                  class="activity-cell"
                  [class.week-start]="cell.weekStart"
                  [class.is-selected]="cell.date === selectedDate()"
                  [attr.data-level]="cell.level"
                  [attr.aria-label]="cell.label"
                  [kTooltip]="cell.label"
                  (click)="daySelected.emit(cell.date)"
                ></button>
              } @else {
                <i
                  class="activity-cell"
                  [class.week-start]="cell.weekStart"
                  [attr.data-level]="cell.level"
                  [kTooltip]="cell.label"
                ></i>
              }
            }
          </div>
        }
      </div>
    </section>
  `,
  styleUrl: "./activity-strip.component.scss",
})
export class ActivityStripComponent {
  readonly series = input.required<ActivityStripSeries[]>();
  readonly windowDays = input.required<number>();
  readonly heading = input("Activity");
  /** Most recent day in the window. Defaults to today. */
  readonly endDate = input<Date | null>(null);
  /** When true, columns become buttons that emit `daySelected`. */
  readonly selectable = input(false);
  readonly selectedDate = input<string | null>(null);

  readonly daySelected = output<string>();

  readonly legendLevels = [0, 1, 2, 3, 4] as const;

  private readonly end = computed(() => this.endDate() ?? new Date());

  readonly windowLabel = computed(() => `Last ${this.windowDays()} days`);

  readonly rows = computed(() =>
    this.series().map((series) => {
      const cells = buildActivityStripCells(series, this.windowDays(), this.end());
      return {
        ...series,
        cells,
        // Totalled over the rendered window, not the whole counts map, so the number always
        // describes what the strip beside it is showing.
        total: cells.reduce((sum, cell) => sum + cell.count, 0),
      };
    })
  );

  /**
   * One entry per day column, carrying text only where a new month starts, so the labels ride exactly
   * the same columns as the cells below them.
   */
  readonly monthCells = computed<string[]>(() => {
    let previous = "";
    return this.rows()[0]?.cells.map((cell, index) => {
      const month = cell.date.slice(0, 7);
      if (month === previous) return "";
      previous = month;
      // The window rarely starts on the 1st; the opening column is labelled anyway so the strip is
      // never left without a date anchor on its left edge.
      return index === 0 || cell.date.endsWith("-01")
        ? parseDateKey(cell.date).toLocaleDateString(undefined, { month: "short" })
        : "";
    }) ?? [];
  });
}
