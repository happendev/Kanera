import { ChangeDetectionStrategy, Component, computed, input, output, signal } from "@angular/core";
import { AnchoredPickerPopover } from "../../../shared/anchored-picker.popover";
import type { PickerGroup, PickerOption } from "../../../shared/picker-list.component";

/**
 * The automation editor's single-value picker.
 *
 * Event, list and action are the three decisions that define a rule, so their controls carry the
 * selected option's icon and open the same descriptive picker used elsewhere in the product. The
 * smaller configuration choices below an action stay compact; promoting every binary choice to a
 * rich menu would bury the rule itself in popovers.
 */
@Component({
  selector: "k-automation-select-dropdown",
  standalone: true,
  imports: [AnchoredPickerPopover],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="asd-root">
      <button
        type="button"
        class="asd-trigger"
        [class.is-open]="open()"
        [class.is-placeholder]="!selectedOption()"
        [attr.aria-label]="triggerAriaLabel()"
        [attr.aria-expanded]="open()"
        aria-haspopup="listbox"
        (click)="toggleOpen()"
      >
        <span class="asd-icon" aria-hidden="true">
          @if (selectedOption()?.dot) {
            <span class="asd-dot" [style.background]="optionColor(selectedOption())"></span>
          } @else {
            <i class="ti ti-{{ selectedOption()?.icon ?? placeholderIcon() }}"></i>
          }
        </span>
        <span class="asd-value">{{ selectedOption()?.label ?? placeholder() }}</span>
        <i class="ti ti-chevron-down asd-chevron" aria-hidden="true"></i>
      </button>

      @if (open()) {
        <k-anchored-picker
          [title]="title()"
          [groups]="groups()"
          [selectedId]="value() || null"
          [searchPlaceholder]="searchPlaceholder()"
          [searchThreshold]="searchThreshold()"
          [emptyLabel]="emptyLabel()"
          [width]="panelWidth()"
          (picked)="select($event)"
          (closed)="open.set(false)"
        />
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }

    .asd-root {
      position: relative;
      min-width: 0;
    }

    .asd-trigger {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      height: 38px;
      min-width: 0;
      padding: 0 9px 0 6px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--field-bg, var(--surface-2));
      color: var(--text);
      font-size: 13px;
      font-weight: 500;
      text-align: left;
      cursor: pointer;
      transition: border-color 0.15s, background-color 0.15s, box-shadow 0.15s;

      &:hover {
        border-color: var(--border-strong);
        background: color-mix(in srgb, var(--field-bg, var(--surface-2)) 86%, var(--surface-hover));
      }

      &.is-open {
        border-color: var(--accent, var(--border-strong));
        background: var(--surface-hover);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, var(--border-strong)) 16%, transparent);

        .asd-chevron {
          transform: rotate(180deg);
        }
      }

      &:focus-visible {
        border-color: var(--accent, var(--border-strong));
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, var(--border-strong)) 20%, transparent);
        outline: none;
      }

      &.is-placeholder .asd-value {
        color: var(--text-muted);
        font-weight: 400;
      }
    }

    .asd-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      flex: 0 0 24px;
      border: 1px solid color-mix(in srgb, var(--accent) 16%, var(--border));
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--accent) 8%, var(--field-bg, var(--surface-2)));
      color: var(--accent);

      i {
        font-size: 15px;
      }
    }

    .asd-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }

    .asd-value {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .asd-chevron {
      flex: 0 0 auto;
      color: var(--text-muted);
      font-size: 14px;
      transition: transform 0.15s;
    }

    @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
      .asd-trigger {
        height: 44px;
      }
    }
  `,
})
export class AutomationSelectDropdownComponent {
  readonly groups = input.required<PickerGroup[]>();
  readonly value = input("");
  readonly title = input("Choose");
  readonly placeholder = input("Choose an option");
  readonly placeholderIcon = input("selector");
  readonly ariaLabel = input("Choose an option");
  readonly searchPlaceholder = input("Search…");
  readonly searchThreshold = input(8);
  readonly emptyLabel = input("Nothing to choose from");
  readonly panelWidth = input(340);

  readonly valueChange = output<string>();
  readonly open = signal(false);

  readonly selectedOption = computed<PickerOption | null>(() => {
    const selectedId = this.value();
    if (!selectedId) return null;
    for (const group of this.groups()) {
      const option = group.options.find(candidate => candidate.id === selectedId);
      if (option) return option;
    }
    return null;
  });

  readonly triggerAriaLabel = computed(() => {
    const selection = this.selectedOption()?.label ?? this.placeholder();
    return `${this.ariaLabel()}: ${selection}`;
  });

  protected optionColor(option: PickerOption | null): string {
    return option?.color ? `var(--color-${option.color})` : "var(--border-strong)";
  }

  protected toggleOpen(): void {
    this.open.update(value => !value);
  }

  protected select(value: string): void {
    this.valueChange.emit(value);
    this.open.set(false);
  }
}
