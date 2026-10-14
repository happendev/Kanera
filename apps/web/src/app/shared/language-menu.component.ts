import { ChangeDetectionStrategy, Component, input, output, signal } from "@angular/core";
import { LOCALE_NATIVE_NAMES, LOCALES, type Locale } from "@kanera/shared/locales";
import { languageName } from "../core/i18n/locale";
import { AnchoredPanelDirective } from "./anchored-panel.directive";
import type { AnchoredPanelPlacement } from "./anchored-panel";
import { MenuDirective } from "./menu.directive";

/**
 * The one interface-language picker, used on the signed-out pages (`ghost`, a quiet footer control)
 * and in profile settings (`field`, sized like a form select). It only reports the pick: the owner
 * decides whether it is saved to the account before the page reloads into the new language.
 */
@Component({
  selector: "k-language-menu",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AnchoredPanelDirective, MenuDirective],
  host: { "[class]": "'is-' + variant()" },
  template: `
    <button #trigger type="button" class="lm-trigger" [class.is-open]="open()" [disabled]="disabled()" (click)="open.set(!open())"
            aria-label="Language" i18n-aria-label="Label of the interface language picker" aria-haspopup="menu" [attr.aria-expanded]="open()">
      <i class="ti ti-language" aria-hidden="true"></i>
      <span class="lm-current" [attr.lang]="value()">{{ names[value()] }}</span>
      <i class="ti ti-chevron-down lm-chevron" aria-hidden="true"></i>
    </button>
    @if (open()) {
    <div kMenu class="lm-menu" role="menu" aria-label="Language" i18n-aria-label="Label of the interface language picker"
         kAnchoredPanel [apAnchor]="trigger" [apPlacement]="placement()" (apDismissed)="open.set(false)">
      @for (option of options; track option.value) {
      <button type="button" class="k-menu-item lm-item" role="menuitemradio" [attr.aria-checked]="option.value === value()"
              [class.is-current]="option.value === value()" (click)="pick(option.value)">
        <span class="lm-names">
          <span class="lm-native" [attr.lang]="option.value">{{ option.native }}</span>
          @if (option.translated) { <span class="lm-translated">{{ option.translated }}</span> }
        </span>
        @if (option.value === value()) { <i class="ti ti-check lm-check" aria-hidden="true"></i> }
      </button>
      }
    </div>
    }
  `,
  styles: [`
    :host { display: flex; }
    :host(.is-ghost) { justify-content: center; }
    .lm-trigger {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      width: auto;
      height: 32px;
      padding: 0 10px;
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      background: transparent;
      color: var(--text-muted);
      font-size: 13px;
      font-weight: 500;
      box-shadow: none;
    }
    .lm-trigger > .ti { font-size: 15px; }
    .lm-chevron {
      margin-left: auto;
      transition: transform var(--motion-fast);
    }
    .lm-trigger:hover:not(:disabled),
    .lm-trigger.is-open {
      border-color: var(--border);
      background: var(--surface);
      color: var(--text);
    }
    .lm-trigger.is-open .lm-chevron { transform: rotate(180deg); }

    /* Field: matches the global select (border, fill, radius, focus ring) so it sits in a settings form. */
    :host(.is-field) .lm-trigger {
      width: 100%;
      max-width: 280px;
      height: 36px;
      gap: var(--space-2);
      border-color: var(--border-strong);
      border-radius: var(--radius);
      background: var(--select-bg);
      color: var(--text);
      font-size: 14px;
      font-weight: 400;
    }
    :host(.is-field) .lm-trigger > .ti { color: var(--text-muted); }
    :host(.is-field) .lm-trigger:hover:not(:disabled),
    :host(.is-field) .lm-trigger.is-open { background: var(--select-bg); border-color: var(--border-strong); }
    :host(.is-field) .lm-trigger.is-open,
    :host(.is-field) .lm-trigger:focus-visible {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--ring);
    }
    :host(.is-field) .lm-trigger:disabled { opacity: 0.6; }
    .lm-current {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .lm-menu { min-width: 232px; }
    .lm-item { gap: var(--space-3); }
    .lm-names {
      display: flex;
      align-items: baseline;
      gap: var(--space-2);
    }
    .lm-native { color: var(--text); }
    .lm-translated {
      overflow: hidden;
      color: var(--text-muted);
      font-size: var(--text-xs);
      font-weight: 400;
      text-overflow: ellipsis;
    }
    .lm-item.is-current .lm-native { font-weight: 600; }
    .k-menu-item > .lm-check { color: var(--accent); }
    @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
      .lm-trigger, .lm-item { min-height: 44px; }
    }
  `],
})
export class LanguageMenuComponent {
  readonly value = input.required<Locale>();
  readonly variant = input<"ghost" | "field">("field");
  readonly disabled = input(false);
  readonly picked = output<Locale>();

  protected readonly names = LOCALE_NATIVE_NAMES;
  // Each language in its own name, so someone who cannot read the current language can still find
  // theirs, with the name in the language on screen beside it for everyone else.
  protected readonly options = LOCALES.map((value) => ({ value, native: LOCALE_NATIVE_NAMES[value], translated: languageName(value) }));
  protected readonly open = signal(false);
  protected readonly placement = () => (this.variant() === "ghost"
    ? { align: "center", width: "measure", gap: 4, minHeight: 300 }
    : { align: "start", width: "measure", gap: 4, minHeight: 300 }) satisfies AnchoredPanelPlacement;

  protected pick(locale: Locale): void {
    this.open.set(false);
    if (locale !== this.value()) this.picked.emit(locale);
  }
}
