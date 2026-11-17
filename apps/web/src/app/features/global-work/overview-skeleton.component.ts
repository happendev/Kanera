import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

type SkeletonSection = { kind: "progress" | "next" | "assigned"; label: number; rows: number[] };
type SkeletonPanel = { name: number; sections: SkeletonSection[] };

/**
 * The overview's shape before its cards arrive: the person strip and a grid of panels on Team Cards,
 * the viewer's one wide panel on My Cards. Built from the overview's own measurements (header band,
 * four stats, section bands, two-line rows), so the first real render lands in place rather than
 * replacing a centred spinner with a full page of panels.
 *
 * Row counts and widths vary panel to panel: identical blocks read as a pattern, not as people.
 */
@Component({
  selector: "k-overview-skeleton",
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./overview-skeleton.component.html",
  styleUrl: "./overview-skeleton.component.scss",
})
export class OverviewSkeletonComponent {
  /** My Cards: the viewer's own panel alone, in the overview's wide layout. */
  readonly solo = input(false);

  protected readonly chipWidths = [92, 78, 70, 84, 74, 88, 66];

  protected readonly panels = computed<SkeletonPanel[]>(() =>
    this.solo()
      ? [
          {
            name: 34,
            sections: [
              { kind: "progress", label: 82, rows: [72, 58] },
              { kind: "next", label: 64, rows: [66, 80, 54] },
              { kind: "assigned", label: 72, rows: [76, 62, 84, 56, 70] },
            ],
          },
        ]
      : [
          { name: 48, sections: [{ kind: "progress", label: 82, rows: [74] }, { kind: "assigned", label: 72, rows: [68, 82] }] },
          { name: 56, sections: [{ kind: "progress", label: 82, rows: [80, 62, 70] }, { kind: "next", label: 64, rows: [] }, { kind: "assigned", label: 72, rows: [72, 58, 84] }] },
          { name: 44, sections: [{ kind: "progress", label: 82, rows: [66, 76] }, { kind: "assigned", label: 72, rows: [82, 60, 74, 68] }] },
          { name: 52, sections: [{ kind: "progress", label: 82, rows: [] }, { kind: "next", label: 64, rows: [] }, { kind: "assigned", label: 72, rows: [70, 84] }] },
          { name: 40, sections: [{ kind: "progress", label: 82, rows: [78] }, { kind: "assigned", label: 72, rows: [64, 80, 58] }] },
          { name: 50, sections: [{ kind: "progress", label: 82, rows: [70, 84] }, { kind: "assigned", label: 72, rows: [76] }] },
        ]
  );
}
