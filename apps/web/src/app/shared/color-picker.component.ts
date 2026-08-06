import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
  signal,
} from "@angular/core";
import type { ColorToken } from "@kanera/shared/colors";
import { COLOR_TOKENS } from "@kanera/shared/colors";
import { AnchoredPanelDirective } from "./anchored-panel.directive";
import { TooltipDirective } from "./tooltip.directive";

const COLOR_LABELS: Record<ColorToken, string> = {
  rose: "Rose", pink: "Pink", red: "Red", orange: "Orange", amber: "Amber", yellow: "Yellow",
  lime: "Lime", green: "Green", emerald: "Emerald", teal: "Teal", cyan: "Cyan", sky: "Sky",
  blue: "Blue", indigo: "Indigo", violet: "Violet", purple: "Purple", fuchsia: "Fuchsia", gray: "Gray", olive: "Olive", brown: "Brown",
};

@Component({
  selector: "k-color-picker",
  standalone: true,
  imports: [AnchoredPanelDirective, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cp-wrapper">
      <button #trigger type="button" class="cp-trigger" [kTooltip]="value() ? colorLabel(value()!) : 'Color'" (click)="toggle()">
        @if (value()) {
          <span class="cp-swatch" [style.background]="'var(--color-' + value() + ')'"></span>
        } @else {
          <span class="cp-none"><i class="ti ti-square"></i></span>
        }
      </button>

      @if (open()) {
        <div
          class="cp-dropdown"
          kAnchoredPanel
          [apAnchor]="trigger"
          [apPlacement]="placement"
          (apDismissed)="open.set(false)"
        >
          <div class="cp-grid">
            <button
              type="button"
              class="cp-cell cp-no-color"
              [class.is-selected]="!value()"
              kTooltip="No color"
              (click)="select(null)"
            >
              <i class="ti ti-square"></i>
            </button>
            @for (token of tokens; track token) {
              <button
                type="button"
                class="cp-cell"
                [class.is-selected]="token === value()"
                [style.background]="'var(--color-' + token + ')'"
                [kTooltip]="colorLabel(token)"
                (click)="select(token)"
              ></button>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .cp-wrapper { position: relative; }

    .cp-trigger {
      width: var(--color-picker-size, 36px);
      height: var(--color-picker-size, 36px);
      padding: 0;
      border-radius: var(--radius);
      background: var(--surface-2);
      border: 1px solid var(--border-strong);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
      &:hover { border-color: var(--accent); background: var(--surface-hover); }
    }

    .cp-swatch {
      width: calc(var(--color-picker-size, 36px) - 16px);
      height: calc(var(--color-picker-size, 36px) - 16px);
      border-radius: 50%;
      display: block;
    }

    .cp-none {
      display: flex;
      align-items: center;
      justify-content: center;
      i { font-size: 16px; color: var(--text-muted); }
    }

    .cp-dropdown {
      width: var(--ap-width, 258px);
      background: var(--surface-overlay);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow);
      padding: 10px;
      overflow: auto;
      overscroll-behavior: contain;
    }

    .cp-grid {
      display: grid;
      grid-template-columns: repeat(7, 28px);
      gap: 6px;
    }

    .cp-cell {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 2px solid transparent;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: box-shadow 0.1s;
      &.cp-no-color { background: var(--surface-2); border-color: var(--border); color: var(--text-muted); }
      &:hover { box-shadow: 0 0 0 3px var(--border-strong); }
      &.is-selected { border-color: var(--text); }
    }
  `,
})
export class ColorPickerComponent {
  readonly value = input<ColorToken | null>(null);
  readonly valueChange = output<ColorToken | null>();

  readonly open = signal(false);
  readonly tokens = COLOR_TOKENS;
  readonly placement = { width: 258, maxHeight: 150, minHeight: 130 } as const;

  colorLabel(token: ColorToken): string {
    return COLOR_LABELS[token];
  }

  toggle() {
    this.open.update((value) => !value);
  }

  select(token: ColorToken | null) {
    this.valueChange.emit(token);
    this.open.set(false);
  }
}
