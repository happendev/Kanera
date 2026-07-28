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
 * Icon-only by default (`showLabels` false), because the primary caller is a five-way view switch
 * that has to survive a phone width; a tooltip carries the name.
 */
@Component({
  selector: "k-segmented",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sg-track" [class.is-sm]="size() === 'sm'" role="group" [attr.aria-label]="ariaLabel()">
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
          (click)="valueChange.emit(option.id)"
        >
          @if (option.icon) {
            <i class="ti ti-{{ option.icon }}" aria-hidden="true"></i>
          }
          @if (showLabels()) {
            <span>{{ option.label }}</span>
          }
        </button>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
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
      }

      .sg-btn {
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

      .sg-btn i {
        font-size: 15px;
        line-height: 1;
      }

      .sg-btn:hover:not(.is-active):not(:disabled) {
        color: var(--text);
      }

      .sg-btn.is-active {
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
  readonly size = input<SegmentedSize>("md");
  readonly ariaLabel = input.required<string>();

  readonly valueChange = output<T>();
}
