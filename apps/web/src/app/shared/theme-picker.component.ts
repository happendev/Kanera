import { ChangeDetectionStrategy, Component, inject, input, output } from "@angular/core";
import type { Theme } from "@kanera/shared/appearance";
import { ThemeService, accentForTheme } from "../core/theme/theme.service";

// Display order is the two families side by side (dark, carbon / light, paper), not the shared
// tuple's order, so each row of a 2x2 phone grid holds one family.
const THEME_OPTIONS: readonly { value: Theme; label: string; icon: string }[] = [
  { value: "dark", label: $localize`:Theme name:Dark`, icon: "moon" },
  { value: "carbon", label: $localize`:Theme name:Carbon`, icon: "moon-stars" },
  { value: "light", label: $localize`:Theme name:Light`, icon: "sun" },
  { value: "paper", label: $localize`:Theme name:Paper`, icon: "note" },
];

/**
 * Theme radio group with a thumbnail per option: a miniature sidebar, page and two tiles painted in
 * that theme's own tokens. Each thumbnail carries its own `data-theme` / `data-accent`, so the
 * global `[data-theme=…]` blocks in styles.scss resolve the tokens inside it exactly as they would
 * on <html> — the preview can never drift from the real palette because it *is* the real palette.
 * The accent shown is the one the user's current choice would resolve to under that theme (blue
 * and green share a slot), so switching never lands on a colour the thumbnail did not promise.
 */
@Component({
  selector: "k-theme-picker",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tp-options" role="radiogroup" aria-label="Theme" i18n-aria-label="Aria label on the theme radio group">
      @for (option of options; track option.value) {
      <button
        type="button"
        class="tp-option"
        role="radio"
        [class.active]="value() === option.value"
        [attr.aria-checked]="value() === option.value"
        (click)="picked.emit(option.value)"
      >
        <span class="tp-thumb" [attr.data-theme]="option.value" [attr.data-accent]="accentFor(option.value)" aria-hidden="true">
          <span class="tp-sidebar">
            <span class="tp-nav is-active"></span>
            <span class="tp-nav"></span>
            <span class="tp-nav"></span>
          </span>
          <span class="tp-page">
            <span class="tp-bar"></span>
            <span class="tp-tile"><span class="tp-line is-accent"></span><span class="tp-line"></span></span>
            <span class="tp-tile"><span class="tp-line"></span><span class="tp-line is-short"></span></span>
          </span>
        </span>
        <span class="tp-label"><i [class]="'ti ti-' + option.icon"></i>{{ option.label }}</span>
      </button>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .tp-options {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 180px));
        gap: 10px;
      }

      /* Container-style button: the global button reset pins a 36px height and an accent fill. */
      .tp-option {
        height: auto;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 0;
        padding: 0;
        border: 1px solid var(--border);
        border-radius: var(--radius);
        background: var(--surface);
        color: var(--text-muted);
        overflow: hidden;
        cursor: pointer;
        transition: border-color var(--motion-fast), color var(--motion-fast), box-shadow var(--motion-fast);
      }

      /* :not(:disabled) for specificity against the global button:hover rule, which would flood the
         tile with the accent fill. */
      .tp-option:hover:not(:disabled) {
        background: var(--surface);
        color: var(--text);
        border-color: var(--border-strong);
      }

      .tp-option.active,
      .tp-option.active:hover:not(:disabled) {
        background: var(--surface);
        border-color: var(--accent);
        color: var(--accent);
        box-shadow: 0 0 0 1px var(--accent);
      }

      /* The thumbnail resolves every var() against its own data-theme, so these are that theme's
         real page, chrome and tile colours, never a hand-picked approximation. */
      .tp-thumb {
        display: flex;
        height: 64px;
        background: var(--bg);
        border-bottom: 1px solid var(--border);
      }

      .tp-sidebar {
        display: flex;
        flex-direction: column;
        gap: 4px;
        width: 28%;
        padding: 8px 6px;
        box-sizing: border-box;
        background: var(--surface);
        border-right: 1px solid var(--border);
      }

      .tp-nav {
        height: 5px;
        border-radius: 2px;
        background: var(--border-strong);
      }

      .tp-nav.is-active {
        background: var(--nav-active-bg);
        box-shadow: inset 0 0 0 1px var(--border-strong);
      }

      .tp-page {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 5px;
        min-width: 0;
        padding: 8px;
        box-sizing: border-box;
      }

      .tp-bar {
        width: 40%;
        height: 5px;
        border-radius: 2px;
        background: var(--accent);
      }

      .tp-tile {
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: 4px 5px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 3px;
        box-shadow: var(--shadow-card);
      }

      .tp-line {
        width: 70%;
        height: 3px;
        border-radius: 2px;
        background: var(--text-muted);
        opacity: 0.55;
      }

      .tp-line.is-short {
        width: 45%;
      }

      .tp-line.is-accent {
        width: 30%;
        background: var(--accent);
        opacity: 1;
      }

      .tp-label {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 7px 8px;
        font-size: var(--text-base);
        font-weight: 500;
      }

      .tp-label i {
        font-size: var(--text-md);
      }

      /* 2x2 rather than four cramped columns: at phone width four thumbnails leave no room for the
         sidebar strip and tiles to read as a layout. */
      @media (max-width: 640px) {
        .tp-options {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
    `,
  ],
})
export class ThemePickerComponent {
  private readonly theme = inject(ThemeService);
  protected readonly options = THEME_OPTIONS;

  readonly value = input.required<Theme>();
  readonly picked = output<Theme>();

  protected accentFor(theme: Theme) {
    return accentForTheme(theme, this.theme.accent());
  }
}
