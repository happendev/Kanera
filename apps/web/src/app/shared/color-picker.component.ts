import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  effect,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import type { ColorToken } from "@kanera/shared/colors";
import { COLOR_TOKENS } from "@kanera/shared/colors";
import { PickerStateService } from "./picker-state.service";
import { TooltipDirective } from "./tooltip.directive";

const COLOR_LABELS: Record<ColorToken, string> = {
  rose: "Rose", pink: "Pink", red: "Red", orange: "Orange", amber: "Amber", yellow: "Yellow",
  lime: "Lime", green: "Green", emerald: "Emerald", teal: "Teal", cyan: "Cyan", sky: "Sky",
  blue: "Blue", indigo: "Indigo", violet: "Violet", purple: "Purple", fuchsia: "Fuchsia", gray: "Gray", olive: "Olive", brown: "Brown",
};

@Component({
  selector: "k-color-picker",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cp-wrapper">
      <button type="button" class="cp-trigger" [kTooltip]="value() ? colorLabel(value()!) : 'Color'" (click)="toggle($event)">
        @if (value()) {
          <span class="cp-swatch" [style.background]="'var(--color-' + value() + ')'"></span>
        } @else {
          <span class="cp-none"><i class="ti ti-square"></i></span>
        }
      </button>

      @if (open()) {
        <div class="cp-dropdown" [style.left.px]="dropdownLeft()" [style.top.px]="dropdownTop()" (click)="$event.stopPropagation()">
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
      position: fixed;
      z-index: 1000;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow);
      padding: 10px;
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
  private readonly pickerState = inject(PickerStateService);
  private readonly id = crypto.randomUUID();

  readonly value = input<ColorToken | null>(null);
  readonly valueChange = output<ColorToken | null>();

  readonly open = signal(false);
  readonly dropdownLeft = signal(0);
  readonly dropdownTop = signal(0);
  readonly tokens = COLOR_TOKENS;

  constructor() {
    effect(() => {
      if (this.pickerState.activeId() !== this.id) {
        this.open.set(false);
      }
    });
  }

  colorLabel(token: ColorToken): string {
    return COLOR_LABELS[token];
  }

  toggle(event: Event) {
    event.stopPropagation();
    const willOpen = !this.open();
    if (willOpen && event.currentTarget instanceof HTMLElement) {
      this.positionDropdown(event.currentTarget);
    }
    this.open.set(willOpen);
    if (willOpen) this.pickerState.open(this.id);
  }

  select(token: ColorToken | null) {
    this.valueChange.emit(token);
    this.open.set(false);
  }

  @HostListener("document:click")
  onDocumentClick() {
    if (this.open()) this.open.set(false);
  }

  @HostListener("window:resize")
  @HostListener("window:scroll")
  onViewportChange() {
    if (this.open()) this.open.set(false);
  }

  private positionDropdown(trigger: HTMLElement) {
    const rect = trigger.getBoundingClientRect();
    const dropdownWidth = 258;
    const dropdownHeight = 126;
    const gap = 6;
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - dropdownWidth - margin);
    const left = Math.min(Math.max(margin, rect.left), maxLeft);
    const belowTop = rect.bottom + gap;
    const aboveTop = rect.top - dropdownHeight - gap;
    const top = belowTop + dropdownHeight + margin <= window.innerHeight
      ? belowTop
      : Math.max(margin, aboveTop);

    this.dropdownLeft.set(left);
    this.dropdownTop.set(top);
  }
}
