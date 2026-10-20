import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

/**
 * A board's identity as a tinted tile: its Tabler icon on a soft wash of its own colour, the same
 * treatment `k-page-header` gives a settings page's badge. Board rows and chips use it so a board
 * is recognised by colour and shape before its name is read. Without a colour the tile is a quiet
 * surface-2 square with a muted glyph rather than nothing, so a list of boards keeps its rhythm.
 */
@Component({
  selector: "k-board-icon",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[style.--bi-size.px]": "size()",
    "[style.--bi-color]": "colorValue()",
    "[style.--bi-color-ink]": "inkValue()",
    "[class.has-color]": "!!colorValue()",
  },
  template: `<i [class]="'ti ti-' + (icon() || 'layout-kanban')" aria-hidden="true"></i>`,
  styles: [
    `
      :host {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
        width: var(--bi-size);
        height: var(--bi-size);
        border-radius: calc(var(--bi-size) / 4);
        background: var(--surface-2);
        color: var(--text-muted);
        box-shadow: inset 0 0 0 1px var(--border);
      }

      :host.has-color {
        /* The light-mode action tone where the theme has one, so the glyph clears contrast on a wash
           of the same hue; the wash itself can stay on the identity colour. */
        color: var(--bi-color-ink);
        background: color-mix(in srgb, var(--bi-color) 18%, transparent);
        box-shadow: none;
      }

      i {
        font-size: calc(var(--bi-size) * 0.62);
        line-height: 1;
      }
    `,
  ],
})
export class BoardIconComponent {
  /** Tabler icon name without the `ti-` prefix. */
  readonly icon = input<string | null>(null);
  /** Workspace colour token (`emerald`), or null for the neutral tile. */
  readonly color = input<string | null>(null);
  readonly size = input(24);

  protected readonly colorValue = computed(() => {
    const token = this.color();
    return token ? `var(--color-${token})` : null;
  });

  protected readonly inkValue = computed(() => {
    const token = this.color();
    return token ? `var(--color-${token}-accent, var(--color-${token}))` : null;
  });
}
