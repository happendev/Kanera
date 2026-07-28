import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { BoardMenuCoordinator } from "./board-menu-coordinator.service";

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
    <div class="label-bar">
      @for (label of visibleLabels(); track label.id) {
      <span class="label-chip"
        [class.is-compressed]="compressed"
        [style.--label-color]="label.color ? 'var(--color-' + label.color + ')' : 'var(--border-strong)'"
        [attr.role]="interactive() ? 'button' : null"
        [attr.tabindex]="interactive() ? 0 : null"
        [attr.aria-label]="interactive() ? (compressed ? 'Expand labels: ' : 'Collapse labels: ') + label.name : null"
        [attr.aria-pressed]="interactive() ? compressed : null"
        [kTooltip]="interactive() ? (compressed ? label.name : 'Collapse labels') : label.name"
        (click)="toggleLabelDisplay($event)"
        (keydown.enter)="toggleLabelDisplay($event)"
        (keydown.space)="toggleLabelDisplay($event)">
        <span class="label-chip-text">{{ label.name }}</span>
      </span>
      }
      @if (showOverflow() && hiddenLabels().length) {
      <span class="label-chip is-overflow" [attr.aria-label]="'More labels: ' + hiddenLabelNames()" [kTooltip]="hiddenLabelNames()">
        +{{ hiddenLabels().length }}
      </span>
      }
    </div>
    }
  `,
  styleUrl: "./card-labels.component.scss",
})
export class CardLabelsComponent {
  private readonly menuCoordinator = inject(BoardMenuCoordinator);

  readonly labels = input<CardLabelPresentation[]>([]);
  /** Dense views can cap named chips and optionally summarize the remainder with a neutral +N. */
  readonly limit = input<number | null>(null);
  readonly showOverflow = input(false);
  /**
   * A label inside another control (the editable table cell) stays presentational so it does not
   * create nested buttons. It still follows the same route-wide compressed preference.
   */
  readonly interactive = input(true);
  readonly labelsCompressed = this.menuCoordinator.labelsCompressed;
  readonly visibleLabels = computed(() => {
    const limit = this.limit();
    return limit === null ? this.labels() : this.labels().slice(0, Math.max(0, limit));
  });
  readonly hiddenLabels = computed(() => this.labels().slice(this.visibleLabels().length));
  readonly hiddenLabelNames = computed(() => this.hiddenLabels().map((label) => label.name).join(", "));

  toggleLabelDisplay(event: Event) {
    if (!this.interactive()) return;
    event.preventDefault();
    event.stopPropagation();

    const chip = event.currentTarget;
    if (chip instanceof HTMLElement) this.animateToggleOrigin(chip);
    this.menuCoordinator.setLabelsCompressed(!this.labelsCompressed());
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
