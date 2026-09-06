import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
} from "@angular/core";
import type { GradientToken } from "@kanera/shared/colors";
import { GRADIENT_TOKENS, SOLID_BACKGROUND_TOKENS } from "@kanera/shared/colors";
import { ApiClient } from "../../core/api/api.client";
import { ANCHORED_HOST_STYLES } from "../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { TooltipDirective } from "../../shared/tooltip.directive";

const GRADIENT_LABELS: Record<GradientToken, string> = {
  sunrise: "Sunrise", ocean: "Ocean", forest: "Forest", dusk: "Dusk",
  midnight: "Midnight", ember: "Ember", mint: "Mint", lavender: "Lavender",
  peach: "Peach", graphite: "Graphite", obsidian: "Obsidian",
  slate: "Slate", stone: "Stone", sand: "Sand", sage: "Sage", charcoal: "Charcoal",
};

@Component({
  selector: "k-board-background",
  standalone: true,
  imports: [TooltipDirective],
  hostDirectives: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bg-panel">
      <div class="bg-head">
        <span class="bg-title">Board background</span>
        <button type="button" class="bg-clear" [disabled]="!value()" (click)="select(null)">
          <i class="ti ti-ban"></i> Clear
        </button>
      </div>
      <div class="bg-group-title">Gradients</div>
      <div class="bg-grid">
        @for (token of gradients; track token) {
          <button
            type="button"
            class="bg-cell"
            [class.is-selected]="token === value()"
            [style.background]="'var(--board-scrim-preview), var(--gradient-' + token + ')'"
            [attr.aria-pressed]="token === value()"
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
      <div class="bg-group-title">Solid</div>
      <div class="bg-grid">
        @for (token of solids; track token) {
          <button
            type="button"
            class="bg-cell"
            [class.is-selected]="token === value()"
            [style.background]="'var(--board-scrim-preview), var(--gradient-' + token + ')'"
            [attr.aria-pressed]="token === value()"
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
  styles: [
    ANCHORED_HOST_STYLES,
    `
    .bg-panel {
      background: var(--surface-overlay);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      padding: 12px;
      /* Width and the narrow-viewport clamp both come from placement now. */
      width: 100%;
      max-height: var(--ap-max-height, none);
      overflow-y: auto;
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

    .bg-group-title {
      margin: 2px 0 6px;
      color: var(--text-muted);
      font-size: var(--text-sm);
      font-weight: 600;
    }

    .bg-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
      margin-bottom: 10px;

      &:last-child { margin-bottom: 0; }
    }

    .bg-cell {
      height: 44px;
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

    .bg-label,
    .bg-check {
      color: var(--tile-gradient-fg);
      text-shadow: 0 1px 2px var(--tile-scrim);
    }

    .bg-label {
      font-size: var(--text-xs);
      font-weight: 600;
      line-height: 1;
    }

    .bg-check {
      position: absolute;
      top: 5px;
      right: 6px;
      font-size: 14px;
    }
  `,
  ],
})
export class BoardBackgroundPopover {
  private readonly api = inject(ApiClient);
  readonly solids: readonly GradientToken[] = SOLID_BACKGROUND_TOKENS;
  readonly gradients: readonly GradientToken[] = GRADIENT_TOKENS.filter((token) => !(SOLID_BACKGROUND_TOKENS as readonly string[]).includes(token));
  private readonly panel = inject(AnchoredPanelDirective);

  constructor() {
    this.panel.configure({
      placement: () => ({ align: "end", width: 320, maxHeight: 420 }),
      // Anchored to the trigger button itself rather than to a wrapper: this control sits directly in
      // the header's icon cluster with no `.menu-anchor` of its own, so there is no wrapper box to
      // measure against.
      anchor: () => this.anchor(),
      onDismiss: () => this.close.emit(),
    });
  }

  readonly boardId = input.required<string>();
  readonly value = input<GradientToken | null>(null);
  readonly anchor = input<HTMLElement | null>(null);
  readonly close = output<void>();


  label(token: GradientToken): string {
    return GRADIENT_LABELS[token];
  }

  async select(token: GradientToken | null) {
    await this.api.patch(`/boards/${this.boardId()}/background`, {
      backgroundGradient: token,
    });
  }
}
