import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";
import { TooltipDirective } from "./tooltip.directive";
import { addDays, localDateKey } from "./day-key.util";
import { formatDate } from "./date-format";
import { icu } from "../core/i18n/icu";

/** One metric to plot. Counts are keyed by local YYYY-MM-DD day; missing days render as zero. */
export interface ActivityStripSeries {
  key: string;
  label: string;
  /**
   * Singular English noun for the per-day tooltip, e.g. "move" reads as "3 moves · Wed, 22 Jul".
   * Only used when `countLabel` is absent; an "s" suffix is not a plural in most languages, so
   * callers should pass `countLabel` with an ICU plural instead.
   */
  noun: string;
  /** Count with its noun ("3 moves"), pluralised for the viewer's language. Preferred over `noun`. */
  countLabel?: (count: number) => string;
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

/** Human label for the rendered history window. Whole-week windows should read as weeks. */
export function activityWindowLabel(days: number): string {
  return days >= 28 && days % 7 === 0
    ? icu($localize`:Activity strip window, in whole weeks:{weeks, plural, one {Past # week} other {Past # weeks}}`, { weeks: days / 7 })
    : icu($localize`:Activity strip window, in days:{days, plural, one {Last # day} other {Last # days}}`, { days });
}

/** "3 moves": the series' own pluralised label, or the English fallback built from `noun`. */
function activityCountLabel(series: Pick<ActivityStripSeries, "noun" | "countLabel">, count: number): string {
  return series.countLabel?.(count) ?? `${count} ${count === 1 ? series.noun : `${series.noun}s`}`;
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
      label: $localize`:Activity strip day tooltip, e.g. "3 moves · Wed, 22 Jul":${activityCountLabel(series, count)}:count: · ${formatDate(day, "weekday", { now: day })}:day:`,
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
 * Every row shares one accent ramp, the one the legend shows: the row labels already say which
 * metric is which, and a second hue per series made the single legend wrong for half the strip.
 *
 * One column per day (rather than a GitHub week grid) is what lets a 60-day window span the panel's
 * width instead of huddling in a corner, and it stacks the metrics on the same day columns for a
 * direct read — a busy movement strip over an empty completion strip is the "lots of churn, nothing
 * shipped" signal these exist to surface.
 *
 * Used by the work-done timeline; kept generic so any per-day activity shares one visual language.
 */
@Component({
  selector: "k-activity-strip",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="activity-panel" [class.is-flat]="flat()" [class.has-range]="hasRange()">
      <header>
        <strong>{{ heading() }}</strong>
        <span>{{ windowLabel() }}@if (flatTotal(); as total) { · {{ total }} }</span>
        <div class="activity-legend">
          <span i18n="Activity heatmap legend: low end of the scale">Less</span>
          @for (level of legendLevels; track level) {
            <i class="activity-cell" [attr.data-level]="level"></i>
          }
          <span i18n="Activity heatmap legend: high end of the scale">More</span>
        </div>
      </header>
      <div class="activity-strips">
        <!-- The period as a faint column wash behind every strip, so it reads across all the rows
             rather than only above the bar under the last one. Out of flow (absolutely placed on the
             strips' grid rows), so it takes no part in the layout. -->
        @if (rangeBand(); as band) {
          <i
            class="activity-range-wash"
            aria-hidden="true"
            [style.grid-row]="'2 / span ' + rows().length"
            [style.--band-start]="band.start"
            [style.--band-span]="band.span"
            [style.--band-columns]="band.columns"
          ></i>
        }
        <span class="activity-row-label"></span>
        <div class="activity-months" aria-hidden="true">
          @for (month of monthCells(); track $index) {
            <span>{{ month }}</span>
          }
        </div>
        @for (row of rows(); track row.key) {
          <div class="activity-row-label">
            <strong>{{ row.label }}</strong>
            <span>{{ row.totalLabel }}</span>
          </div>
          <div class="activity-strip">
            @for (cell of row.cells; track cell.date) {
              @if (selectable()) {
                <button
                  type="button"
                  class="activity-cell"
                  [class.week-start]="cell.weekStart"
                  [class.is-selected]="cell.date === selectedDate()"
                  [class.out-of-range]="isOutOfRange(cell.date)"
                  [attr.data-level]="cell.level"
                  [attr.aria-label]="cell.label"
                  [kTooltip]="cell.label"
                  (click)="daySelected.emit(cell.date)"
                ></button>
              } @else {
                <i
                  class="activity-cell"
                  [class.week-start]="cell.weekStart"
                  [class.out-of-range]="isOutOfRange(cell.date)"
                  [attr.data-level]="cell.level"
                  [kTooltip]="cell.label"
                ></i>
              }
            }
            <!-- Under the last strip only, so the one bar marks the period for every row above it. -->
            @if ($last && rangeBand(); as band) {
              <i
                class="activity-range"
                aria-hidden="true"
                [style.--band-start]="band.start"
                [style.--band-span]="band.span"
                [style.--band-columns]="band.columns"
              ></i>
            }
          </div>
        }
        <!-- Narrow layouts drop the month row and the legend; the window's first and last day keep
             the strip anchored in time. Shown only there (see the stylesheet). -->
        @if (windowEnds(); as ends) {
          <div class="activity-ends" aria-hidden="true">
            <span>{{ ends.start }}</span>
            <span>{{ ends.end }}</span>
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
  readonly heading = input($localize`:Activity strip default heading:Activity`);
  /** Most recent day in the window. Defaults to today. */
  readonly endDate = input<Date | null>(null);
  /** When true, columns become buttons that emit `daySelected`. */
  readonly selectable = input(false);
  readonly selectedDate = input<string | null>(null);
  /**
   * The period the host is showing (local YYYY-MM-DD, inclusive). Days outside it are dimmed, so a
   * strip that is wider than the period cannot read as contradicting an empty result below it.
   */
  readonly rangeStart = input<string | null>(null);
  readonly rangeEnd = input<string | null>(null);
  /**
   * For a single-series strip inside a host panel that already frames it (home's Your progress):
   * no frame of its own, and no row label repeating the heading. A non-zero window total moves into
   * the header instead; a zero is left to the empty cells and the host's own figure.
   */
  readonly flat = input(false);

  readonly daySelected = output<string>();

  readonly legendLevels = [0, 1, 2, 3, 4] as const;

  private readonly end = computed(() => this.endDate() ?? new Date());

  readonly windowLabel = computed(() => {
    const days = this.windowDays();
    // Whole-week reporting windows read as the intentional period they are, rather than exposing
    // an implementation-sized day count such as "56 days" to the user.
    return activityWindowLabel(days);
  });

  /**
   * Only marks a range that overlaps the window: one entirely before it would dim every column,
   * which reads as a broken strip rather than as "your period is not here".
   */
  readonly hasRange = computed(() => {
    const start = this.rangeStart();
    const end = this.rangeEnd();
    const cells = this.rows()[0]?.cells;
    if (!start || !end || !cells?.length) return false;
    const first = cells[0].date;
    const last = cells[cells.length - 1].date;
    const covers = start <= first && end >= last;
    return start <= last && end >= first && !covers;
  });

  isOutOfRange(date: string): boolean {
    // Date keys are zero-padded YYYY-MM-DD, so string order is calendar order.
    return this.hasRange() && (date < this.rangeStart()! || date > this.rangeEnd()!);
  }

  /**
   * The host's period as one bar under the strips, in column units of the window. One continuous
   * marker rather than a ring per day: seven ringed cells read as seven inputs, and the bar also
   * spans the gaps between columns, so the period reads as a single stretch of time.
   */
  readonly rangeBand = computed(() => {
    if (!this.hasRange()) return null;
    const cells = this.rows()[0].cells;
    const start = cells.findIndex((cell) => !this.isOutOfRange(cell.date));
    if (start < 0) return null;
    let end = start;
    while (end + 1 < cells.length && !this.isOutOfRange(cells[end + 1].date)) end += 1;
    // A one-day period that is the selected day already wears the selected outline in every row; a
    // bar under it as well only doubles the marker.
    if (start === end && cells[start].date === this.selectedDate()) return null;
    return { start, span: end - start + 1, columns: cells.length };
  });

  readonly windowEnds = computed(() => {
    const cells = this.rows()[0]?.cells;
    if (!cells?.length) return null;
    return { start: formatDate(cells[0].date, "short"), end: formatDate(cells[cells.length - 1].date, "short") };
  });

  readonly flatTotal = computed(() => {
    const row = this.rows()[0];
    return this.flat() && row && row.total > 0 ? row.totalLabel : null;
  });

  readonly rows = computed(() =>
    this.series().map((series) => {
      const cells = buildActivityStripCells(series, this.windowDays(), this.end());
      // Totalled over the rendered window, not the whole counts map, so the number always
      // describes what the strip beside it is showing.
      const total = cells.reduce((sum, cell) => sum + cell.count, 0);
      return {
        ...series,
        cells,
        total,
        totalLabel: activityCountLabel(series, total),
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
        ? formatDate(cell.date, "month")
        : "";
    }) ?? [];
  });
}
