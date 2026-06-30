import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  input,
  output,
  signal,
} from "@angular/core";
import type { GradientToken } from "@kanera/shared/colors";
import { GRADIENT_TOKENS } from "@kanera/shared/colors";
import { TooltipDirective } from "./tooltip.directive";

const GRADIENT_LABELS: Record<GradientToken, string> = {
  sunrise: "Sunrise", ocean: "Ocean", forest: "Forest", dusk: "Dusk",
  midnight: "Midnight", ember: "Ember", mint: "Mint", lavender: "Lavender",
  peach: "Peach", graphite: "Graphite",
};

@Component({
  selector: "k-gradient-picker",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="gp-wrapper">
      <button type="button" class="gp-trigger" (click)="toggle($event)">
        @if (value()) {
          <span class="gp-preview" [style.background]="'var(--gradient-' + value() + ')'"></span>
        } @else {
          <span class="gp-none"><i class="ti ti-ban"></i></span>
        }
      </button>

      @if (open()) {
        <div class="gp-dropdown" (click)="$event.stopPropagation()">
          <div class="gp-grid">
            <button
              type="button"
              class="gp-cell gp-no-bg"
              [class.is-selected]="!value()"
              kTooltip="No background"
              (click)="select(null)"
            >
              <i class="ti ti-ban"></i>
              <span>None</span>
            </button>
            @for (token of tokens; track token) {
              <button
                type="button"
                class="gp-cell"
                [class.is-selected]="token === value()"
                [style.background]="'var(--gradient-' + token + ')'"
                [kTooltip]="gradientLabel(token)"
                (click)="select(token)"
              >
                <span class="gp-label">{{ gradientLabel(token) }}</span>
              </button>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .gp-wrapper { position: relative; }

    .gp-trigger {
      width: 36px;
      height: 36px;
      padding: 0;
      border-radius: var(--radius);
      background: var(--surface-2);
      border: 1px solid var(--border-strong);
      overflow: hidden;
      cursor: pointer;
      flex-shrink: 0;
      &:hover { border-color: var(--accent); }
    }

    .gp-preview {
      display: block;
      width: 100%;
      height: 100%;
    }

    .gp-none {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      i { font-size: 16px; color: var(--text-muted); }
    }

    .gp-dropdown {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 100;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
      padding: 8px;
      width: 264px;
    }

    .gp-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
    }

    .gp-cell {
      height: 52px;
      border-radius: var(--radius);
      border: 2px solid transparent;
      cursor: pointer;
      display: flex;
      align-items: flex-end;
      justify-content: flex-start;
      padding: 4px 6px;
      overflow: hidden;
      position: relative;
      &.gp-no-bg {
        background: var(--surface-2);
        border-color: var(--border);
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 2px;
        i { font-size: 14px; color: var(--text-muted); }
        span { font-size: 10px; color: var(--text-muted); }
      }
      &:hover { opacity: 0.9; }
      &.is-selected { border-color: white; box-shadow: 0 0 0 1px var(--accent); }
    }

    .gp-label {
      font-size: 10px;
      color: white;
      font-weight: 600;
      text-shadow: 0 1px 2px rgba(0,0,0,0.5);
      line-height: 1;
    }
  `,
})
export class GradientPickerComponent {
  readonly value = input<GradientToken | null>(null);
  readonly valueChange = output<GradientToken | null>();

  readonly open = signal(false);
  readonly tokens = GRADIENT_TOKENS;

  gradientLabel(token: GradientToken): string {
    return GRADIENT_LABELS[token];
  }

  toggle(event: Event) {
    event.stopPropagation();
    this.open.update((v) => !v);
  }

  select(token: GradientToken | null) {
    this.valueChange.emit(token);
    this.open.set(false);
  }

  @HostListener("document:click")
  onDocumentClick() {
    if (this.open()) this.open.set(false);
  }
}
