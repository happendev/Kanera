import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";
import { DensityService } from "../../core/theme/density.service";
import { CardLabelDisplayService } from "../../shared/card-label-display.service";
import { TooltipDirective } from "../../shared/tooltip.directive";

export interface CardLabelPresentation {
  id: string;
  name: string;
  color: string | null;
}

const LABEL_TRANSITION_FALLBACK_MS = 220;

@Component({
  selector: "k-card-labels",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (labels().length) {
    @let compressed = labelsCompressed();
    @let dot = dotVariant();
    <div class="label-bar">
      @for (label of visibleLabels(); track label.id) {
      <span class="label-chip"
        [class.is-compressed]="compressed"
        [class.is-dot]="dot"
        [style.--label-color]="label.color ? 'var(--color-' + label.color + ')' : 'var(--border-strong)'"
        [attr.role]="interactive() ? 'button' : null"
        [attr.tabindex]="interactive() ? 0 : null"
        [attr.aria-label]="interactive() ? (compressed ? expandLabel(label.name) : collapseLabel(label.name)) : null"
        [attr.aria-pressed]="interactive() ? compressed : null"
        [kTooltip]="interactive() ? (compressed ? label.name : collapseTooltip) : label.name"
        (click)="toggleLabelDisplay($event)"
        (keydown.enter)="toggleLabelDisplay($event)"
        (keydown.space)="toggleLabelDisplay($event)">
        <span class="label-chip-text">{{ label.name }}</span>
      </span>
      }
      @if (showOverflow() && hiddenLabels().length) {
      <span class="label-chip is-overflow" [attr.aria-label]="moreLabels()" [kTooltip]="hiddenLabelNames()">
        +{{ hiddenLabels().length }}
      </span>
      }
    </div>
    }
  `,
  styleUrl: "./card-labels.component.scss",
})
export class CardLabelsComponent {
  // The root display service, never the route-scoped BoardMenuCoordinator: these chips also render
  // in shell chrome (the Up next drawer), which sits outside every route that provides it.
  private readonly labelDisplay = inject(CardLabelDisplayService);
  private readonly density = inject(DensityService);

  readonly labels = input<CardLabelPresentation[]>([]);
  /** Dense views can cap named chips and optionally summarize the remainder with a neutral +N. */
  readonly limit = input<number | null>(null);
  readonly showOverflow = input(false);
  /** Table rows keep label names visible regardless of the app-wide board-card preference. */
  readonly alwaysExpanded = input(false);
  /**
   * A label inside another control (the editable table cell) stays presentational so it does not
   * create nested buttons. Unless alwaysExpanded is set, it follows the shared display preference.
   */
  readonly interactive = input(true);
  readonly labelsCompressed = computed(() => !this.alwaysExpanded() && this.labelDisplay.labelsCompressed());
  /**
   * Compact density swaps the filled pill for a colour dot beside plain text, so three labels on a
   * tile stay quiet. It is a device setting, so every surface follows it; the compressed (dot-only)
   * toggle still works on top of it.
   */
  readonly dotVariant = computed(() => this.density.compact() && !this.labelsCompressed());
  readonly visibleLabels = computed(() => {
    const limit = this.limit();
    return limit === null ? this.labels() : this.labels().slice(0, Math.max(0, limit));
  });
  readonly hiddenLabels = computed(() => this.labels().slice(this.visibleLabels().length));
  readonly hiddenLabelNames = computed(() => this.hiddenLabels().map((label) => label.name).join(", "));
  readonly moreLabels = computed(() => $localize`:Aria label on the +N chip; the hidden label names follow:More labels: ${this.hiddenLabelNames()}:labels:`);
  readonly collapseTooltip = $localize`:Tooltip on a label chip that collapses all labels to colour bars:Collapse labels`;

  expandLabel(name: string) {
    return $localize`:Aria label on a collapsed label chip; the label name follows:Expand labels: ${name}:label:`;
  }

  collapseLabel(name: string) {
    return $localize`:Aria label on an expanded label chip; the label name follows:Collapse labels: ${name}:label:`;
  }

  toggleLabelDisplay(event: Event) {
    if (!this.interactive()) return;
    event.preventDefault();
    event.stopPropagation();

    const chip = event.currentTarget;
    if (chip instanceof HTMLElement) this.animateToggleOrigin(chip);
    this.labelDisplay.setLabelsCompressed(!this.labelsCompressed());
  }

  private animateToggleOrigin(chip: HTMLElement) {
    chip.classList.add("is-toggle-origin");

    let fallbackTimer = 0;
    const cleanup = () => {
      chip.classList.remove("is-toggle-origin");
      chip.removeEventListener("transitionend", onTransitionEnd);
      if (fallbackTimer) window.clearTimeout(fallbackTimer);
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.propertyName === "max-width") cleanup();
    };

    chip.addEventListener("transitionend", onTransitionEnd);
    // Reduced-motion and detached test DOMs do not emit transitionend.
    fallbackTimer = window.setTimeout(cleanup, LABEL_TRANSITION_FALLBACK_MS);
  }
}
