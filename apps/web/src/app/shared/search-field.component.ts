import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";

/**
 * The app's one search box.
 *
 * Replaces five near-identical implementations (`.bf-search` on the board, `.search-control` on
 * Global Work, `.tv-search` in the table view, `.member-search` in page-styles, and the
 * notifications panel's own), which had drifted to three different heights, two different clear
 * affordances and two different focus treatments.
 *
 * Every `:host`-prefixed rule below is load-bearing rather than decoration: the global reset in
 * styles.scss (`input:not([type=checkbox]):not([type=radio])`) has higher specificity than a bare
 * class, so a plain `.sf-input` rule loses its height, padding and fill to the 36px app input and
 * keeps the global accent focus ring on top of the wrapper's own. Scoping through the host outranks
 * the reset, which is the same fix `PANEL_INPUT_STYLES` documents in shared/anchored-panel.ts and
 * what lets the `!important` workarounds on board.page.scss and page-styles.scss go away.
 */
@Component({
  selector: "k-search-field",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="sf-field" [class.is-disabled]="disabled()">
      <i class="ti ti-search" aria-hidden="true"></i>
      <input
        class="sf-input"
        type="search"
        [attr.aria-label]="ariaLabel() ?? placeholder()"
        [value]="value()"
        [disabled]="disabled()"
        [placeholder]="placeholder()"
        (input)="valueChange.emit($any($event.target).value)"
      />
      @if (value() && !disabled()) {
        <button class="sf-clear" type="button" aria-label="Clear search" (click)="valueChange.emit('')">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>
      }
    </label>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
        /* Overridable by the host: k-page-toolbar sets 100% and flexes the slot instead, so the field
           takes whatever the controls on its row leave; the clamp is for a field outside a toolbar. */
        width: var(--search-field-width, clamp(180px, 22vw, 320px));
      }

      .sf-field {
        display: flex;
        align-items: center;
        gap: 6px;
        height: 36px;
        padding: 0 4px 0 10px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        transition: border-color 0.12s, box-shadow 0.12s;
      }

      .sf-field:focus-within {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--ring);
      }

      .sf-field.is-disabled {
        opacity: 0.55;
      }

      .sf-field > i {
        flex: none;
        color: var(--text-muted);
        font-size: 15px;
        pointer-events: none;
      }

      /* Prefixed with :host to outrank the global input reset — see the class comment. */
      :host .sf-input {
        flex: 1;
        min-width: 0;
        height: 100%;
        padding: 0;
        color: var(--text);
        background: transparent;
        border: 0;
        border-radius: 0;
        outline: none;
        box-shadow: none;
        font: inherit;
        font-size: 13px;
      }

      :host .sf-input:focus {
        border-color: transparent;
        box-shadow: none;
      }

      /* The UA search widget draws its own clear affordance, which would sit beside ours. */
      :host .sf-input::-webkit-search-cancel-button {
        appearance: none;
      }

      .sf-input::placeholder {
        color: var(--text-muted);
      }

      .sf-clear {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
        width: 26px;
        height: 26px;
        padding: 0;
        color: var(--text-muted);
        background: transparent;
        border: 0;
        border-radius: var(--radius-sm);
        cursor: pointer;
      }

      .sf-clear:hover {
        color: var(--text);
        background: var(--surface-2);
      }

      .sf-clear i {
        font-size: 12px;
      }

      /* Coarse pointers get the shared 44px floor; see toolbar-styles.scss. */
      @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
        .sf-field {
          height: 44px;
        }

        .sf-clear {
          width: 32px;
          height: 32px;
        }
      }
    `,
  ],
})
export class SearchFieldComponent {
  readonly value = input("");
  readonly placeholder = input("Search");
  readonly disabled = input(false);
  /** Defaults to the placeholder, which is the label in every current caller. */
  readonly ariaLabel = input<string | null>(null);

  readonly valueChange = output<string>();
}
