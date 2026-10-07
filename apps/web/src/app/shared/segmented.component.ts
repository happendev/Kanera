import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";
import { TooltipDirective } from "./tooltip.directive";

/**
 * `md` is the toolbar size, matching `.k-toolbar-*` at 36px. `sm` is for dense chrome that is not a
 * page toolbar — the notifications drawer's own header row. Only the height changes: the track/pill
 * treatment is identical, which is the part that had to stop varying.
 */
export type SegmentedSize = "sm" | "md";

export type SegmentedOption<T extends string = string> = {
  id: T;
  /** Tabler icon name without the `ti-` prefix. Required when `showLabels` is false. */
  icon?: string;
  label: string;
  /** Defaults to `label`; only shown when the segment renders icon-only. */
  tooltip?: string;
  /**
   * The visible text for `autoLabels` mode ("Table" rather than "Table view"): beside its icon the
   * word "view" is redundant, while `label` stays the full accessible name. Defaults to `label`.
   */
  shortLabel?: string;
  disabled?: boolean;
};

/**
 * The app's one segmented control.
 *
 * Replaces four near-identical implementations that had each picked a different active treatment:
 * the board's view toggle (raised pill + accent text, 28×26 buttons), Global Work's display switch
 * (raised pill, 30×36), work-done's presets, and the notifications Unread/All pills. Pattern B —
 * a recessed `--surface-2` track with a raised `--surface` pill — won because it is the only one
 * that reads correctly on both the board's tinted header and a plain page surface.
 *
 * Keep the active treatment here and only here. Divergent per-caller active states are the mess this
 * control exists to have cleaned up.
 *
 * Icon-only by default (`showLabels` false), because the primary caller is a five-way view switch
 * that has to survive a phone width; a tooltip carries the name.
 */
@Component({
  selector: "k-segmented",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sg-track" [class.is-sm]="size() === 'sm'" [class.is-equal]="equalWidths()" role="group" [attr.aria-label]="ariaLabel()">
      @for (option of options(); track option.id) {
        <button
          type="button"
          class="sg-btn"
          [class.is-active]="option.id === value()"
          [disabled]="!!option.disabled"
          [attr.aria-pressed]="option.id === value()"
          [attr.aria-label]="showLabels() ? null : option.label"
          [kTooltip]="option.tooltip ?? option.label"
          [kTooltipDisabled]="showLabels()"
          [kTooltipTruncationTarget]="autoLabels() ? '.sg-auto-label' : null"
          (click)="valueChange.emit(option.id)"
        >
          @if (option.icon) {
            <i class="ti ti-{{ option.icon }}" aria-hidden="true"></i>
          }
          @if (showLabels()) {
            <span>{{ option.label }}</span>
          } @else if (autoLabels()) {
            <span class="sg-auto-label" aria-hidden="true">{{ option.shortLabel ?? option.label }}</span>
          }
        </button>
      }
    </div>
  `,
  styles: [
    `
      /* --sg-fill-width / --sg-fill-flex let a container stretch the track and share its width
         equally between segments (k-page-header's compact view row) without reaching into this
         component's styles. Unset, the control keeps its intrinsic size. */
      :host {
        display: inline-flex;
        width: var(--sg-fill-width, auto);
        min-width: 0;
      }

      .sg-track {
        display: inline-flex;
        align-items: center;
        flex: none;
        gap: 2px;
        height: 36px;
        padding: 3px;
        /* A subtle track with a raised pill for the active segment, rather than per-button borders
           that clashed with tinted toolbar backgrounds. */
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        width: var(--sg-fill-width, auto);
      }

      .sg-btn {
        flex: var(--sg-fill-flex, 0 1 auto);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-width: 30px;
        height: 100%;
        padding: 0 6px;
        color: var(--text-muted);
        background: transparent;
        border: 0;
        border-radius: calc(var(--radius) - 3px);
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.12s, color 0.12s, box-shadow 0.12s;
      }

      /* Equal segments via an intrinsically-sized inline-grid: 1fr columns in a shrink-to-fit grid
         all resolve to the widest item's max-content size, which flex cannot do without a definite
         track width. align-items: stretch replaces the flex centring the buttons relied on. */
      .sg-track.is-equal {
        display: inline-grid;
        grid-auto-flow: column;
        grid-auto-columns: 1fr;
        align-items: stretch;
      }

      .sg-btn i {
        font-size: 15px;
        line-height: 1;
      }

      /* autoLabels: the label is always rendered but collapsed to zero width, so the host can measure
         its natural width (scrollWidth) to decide whether there is room, and reveal it with one rule
         (k-page-header.is-roomy, below) without re-rendering. Collapsed, it is also what
         tells the tooltip to show: kTooltipTruncationTarget sees it as cut short, so the tooltip
         appears exactly while the text is hidden and stands down once it is visible. The gap moves
         onto the label's margin so a collapsed label costs no width at all. */
      .sg-btn:has(.sg-auto-label) {
        gap: 0;
      }

      .sg-auto-label {
        display: inline-block;
        max-width: 0;
        overflow: hidden;
        white-space: nowrap;
      }

      /* The reveal. The header sets .is-roomy only once the whole title, every control and these
         labels fit with margin (PageHeaderComponent.measureFit). :host-context rather than a rule in
         toolbar-styles.scss: that file is compiled into each page's scoped styles, which cannot
         reach this component's own spans. */
      :host-context(k-page-header.is-roomy) .sg-auto-label {
        max-width: none;
        margin-left: 6px;
      }

      :host-context(k-page-header.is-roomy) .sg-btn:has(.sg-auto-label) {
        padding-inline: 10px;
      }

      /* Hover lifts the label and nothing else. The background has to be restated here, because the
         base button rule in styles.scss paints background: var(--accent-hover) on hover and
         button:hover:not(:disabled) — (0,2,1) — outranks the plain .sg-btn fill, which is only
         (0,2,0) once Angular appends its scoping attribute. Hovering an inactive segment therefore
         flooded it with accent, so a hover read as a selection. */
      .sg-btn:hover:not(:disabled) {
        color: var(--text);
        background: transparent;
      }

      /* The global button rule focuses with a 2px --bg + 4px --accent halo, which on a segment
         paints an accent blob over the neighbouring segments and the track itself — it reads as a
         selection state rather than as focus. A thin outline inset inside the pill keeps the
         indicator (and its contrast) without touching the control's resting look. */
      .sg-btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
        box-shadow: none;
      }

      .sg-btn.is-active:focus-visible {
        box-shadow: var(--shadow-sm);
      }

      /* The raised pill is the one and only fill in this control, so the hover rule above must not
         take it away when the active segment is the one under the cursor — hence the explicit
         :hover here, which outranks it. */
      .sg-btn.is-active,
      .sg-btn.is-active:hover:not(:disabled) {
        color: var(--text);
        background: var(--surface);
        box-shadow: var(--shadow-sm);
      }

      .sg-btn:disabled {
        cursor: default;
        opacity: 0.55;
      }

      .sg-track.is-sm {
        height: 28px;
        padding: 2px;
      }

      .sg-track.is-sm .sg-btn {
        min-width: 24px;
        padding: 0 8px;
        font-size: 11px;
        font-weight: 600;
      }

      .sg-track.is-sm .sg-btn i {
        font-size: 13px;
      }

      /* Coarse pointers get the shared 44px floor; see toolbar-styles.scss. The sm variant stops at
         36px: it sits in a dense drawer grid where a 44px control would push the rows below it off
         a phone screen, and it is never the only way to reach what it filters. */
      @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
        .sg-track {
          height: 44px;
        }

        .sg-btn {
          min-width: 44px;
        }

        .sg-track.is-sm {
          height: 36px;
        }

        .sg-track.is-sm .sg-btn {
          min-width: 36px;
        }
      }
    `,
  ],
})
export class SegmentedComponent<T extends string = string> {
  readonly options = input.required<readonly SegmentedOption<T>[]>();
  readonly value = input<T | null>(null);
  /** False renders icon + tooltip only, which is what a 4–5 way switch needs to fit a phone. */
  readonly showLabels = input(false);
  /**
   * Icon-only, with a short label a containing header reveals when its row has room for it (see
   * PageHeaderComponent's `is-roomy`). Ignored when `showLabels` is set.
   */
  readonly autoLabels = input(false);
  /**
   * Sizes every segment to the widest one. Opt-in because most label-mode callers are a range or
   * period switch where uneven widths read fine; a two-way state toggle does not — "Unread"/"All"
   * at intrinsic widths looks like two different controls sharing a track.
   */
  readonly equalWidths = input(false);
  readonly size = input<SegmentedSize>("md");
  readonly ariaLabel = input.required<string>();

  readonly valueChange = output<T>();
}
