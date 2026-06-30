import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  inject,
  input,
  output,
} from "@angular/core";
import type { GradientToken } from "@kanera/shared/colors";
import { GRADIENT_TOKENS } from "@kanera/shared/colors";
import { ApiClient } from "../../core/api/api.client";
import { TooltipDirective } from "../../shared/tooltip.directive";

const GRADIENT_LABELS: Record<GradientToken, string> = {
  sunrise: "Sunrise", ocean: "Ocean", forest: "Forest", dusk: "Dusk",
  midnight: "Midnight", ember: "Ember", mint: "Mint", lavender: "Lavender",
  peach: "Peach", graphite: "Graphite",
};

@Component({
  selector: "k-board-background",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bg-panel" (click)="$event.stopPropagation()">
      <div class="bg-head">
        <span class="bg-title">Board background</span>
        <button type="button" class="bg-clear" [disabled]="!value()" (click)="select(null)">
          <i class="ti ti-ban"></i> Clear
        </button>
      </div>
      <div class="bg-grid">
        @for (token of tokens; track token) {
          <button
            type="button"
            class="bg-cell"
            [class.is-selected]="token === value()"
            [style.background]="'var(--gradient-' + token + ')'"
            [kTooltip]="label(token)"
            (click)="select(token)"
          >
            <span class="bg-label">{{ label(token) }}</span>
            @if (token === value()) {
              <i class="ti ti-check bg-check"></i>
            }
          </button>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      z-index: 200;
    }

    .bg-panel {
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
      padding: 12px;
      width: 320px;
    }

    @media (max-width: 480px) {
      .bg-panel {
        width: min(320px, calc(100vw - 32px));
      }
    }

    .bg-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }

    .bg-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .bg-clear {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 12px;
      cursor: pointer;
      padding: 4px 6px;
      border-radius: var(--radius-sm);
      &:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
      &:disabled { opacity: 0.4; cursor: default; }
      i { font-size: 13px; }
    }

    .bg-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
    }

    .bg-cell {
      height: 56px;
      border-radius: var(--radius);
      border: 2px solid transparent;
      cursor: pointer;
      display: flex;
      align-items: flex-end;
      justify-content: flex-start;
      padding: 6px 8px;
      overflow: hidden;
      position: relative;
      transition: transform 80ms ease;
      &:hover { transform: translateY(-1px); }
      &.is-selected { border-color: var(--text); box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--accent, var(--text)); }
    }

    .bg-label {
      font-size: 11px;
      color: white;
      font-weight: 600;
      text-shadow: 0 1px 2px rgba(0,0,0,0.5);
      line-height: 1;
    }

    .bg-check {
      position: absolute;
      top: 6px;
      right: 6px;
      color: white;
      font-size: 14px;
      text-shadow: 0 1px 2px rgba(0,0,0,0.5);
    }
  `,
})
export class BoardBackgroundPopover {
  private readonly api = inject(ApiClient);

  readonly boardId = input.required<string>();
  readonly value = input<GradientToken | null>(null);
  readonly close = output<void>();

  readonly tokens = GRADIENT_TOKENS;

  label(token: GradientToken): string {
    return GRADIENT_LABELS[token];
  }

  async select(token: GradientToken | null) {
    await this.api.patch(`/boards/${this.boardId()}/background`, {
      backgroundGradient: token,
    });
  }

  @HostListener("document:click")
  onDocumentClick() {
    this.close.emit();
  }
}
