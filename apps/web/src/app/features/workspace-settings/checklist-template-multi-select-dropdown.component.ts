import { ChangeDetectionStrategy, Component, computed, input, output, signal } from "@angular/core";
import type { WireChecklistTemplate } from "@kanera/shared/events";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";

@Component({
  selector: "k-checklist-template-multi-select-dropdown",
  standalone: true,
  imports: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cms">
      <button #trigger type="button" class="cms-trigger" [class.is-open]="open()" (click)="toggleOpen()" [attr.aria-expanded]="open()" aria-haspopup="listbox">
        <i class="ti ti-list-check"></i>
        <span class="cms-label">{{ selectedLabel() }}</span>
        <i class="ti ti-chevron-down cms-chevron"></i>
      </button>

      @if (open()) {
        <div
          class="cms-panel"
          kAnchoredPanel
          [apAnchor]="trigger"
          [apPlacement]="placement"
          (apDismissed)="open.set(false)"
        >
          <input
            class="cms-search"
            type="text"
            placeholder="Search checklists..."
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
          <div class="cms-list" role="listbox" aria-multiselectable="true">
            @if (filteredTemplates().length === 0) {
              <p class="cms-empty">No matching checklists</p>
            }
            @for (template of filteredTemplates(); track template.id) {
              <button type="button" class="cms-row" [class.is-selected]="isSelected(template.id)" (click)="toggleTemplate(template.id)" role="option" [attr.aria-selected]="isSelected(template.id)">
                <i class="ti ti-list-check cms-row-icon"></i>
                <span class="cms-template">
                  <span class="cms-title">{{ template.title }}</span>
                  <span class="cms-count">{{ template.items.length }} {{ template.items.length === 1 ? "item" : "items" }}</span>
                </span>
                @if (isSelected(template.id)) {
                  <i class="ti ti-check cms-check"></i>
                }
              </button>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }

    /* --field-bg lets the host seat this trigger at the same depth as its native selects; hosts that
       do not set it keep the previous --surface-2 fill. */
    .cms-trigger {
      width: 100%;
      height: 34px;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 0 9px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--field-bg, var(--surface-2));
      color: var(--text);
      cursor: pointer;
      text-align: left;
      font-size: 13px;

      &:hover,
      &.is-open {
        border-color: var(--border-strong);
        background: var(--surface-hover);
      }

      &:focus-visible {
        border-color: var(--accent, var(--border-strong));
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, var(--border-strong)) 20%, transparent);
        outline: none;
      }
    }

    .cms-trigger > i:not(.cms-chevron) {
      color: var(--text-muted);
      font-size: 15px;
    }

    .cms-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .cms-chevron {
      color: var(--text-muted);
      font-size: 14px;
      flex: 0 0 auto;
    }

    .cms-panel {
      width: var(--ap-width, 320px);
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 8px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius);
      background: var(--surface-overlay);
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.22);
      overflow: hidden;
    }

    .cms-search {
      height: 32px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      color: var(--text);
      padding: 0 8px;
      font-size: 13px;
      outline: none;

      &:focus {
        border-color: var(--accent, var(--text));
      }
    }

    .cms-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-height: 0;
      overflow-y: auto;
    }

    .cms-row {
      width: 100%;
      min-height: 38px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text);
      cursor: pointer;
      text-align: left;

      &:hover,
      &.is-selected {
        background: var(--surface-2);
      }
    }

    .cms-row-icon,
    .cms-check {
      color: var(--accent, var(--text));
      font-size: 15px;
      flex: 0 0 auto;
    }

    .cms-template {
      flex: 1;
      min-width: 0;
      display: grid;
      gap: 1px;
    }

    .cms-title,
    .cms-count {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .cms-title {
      font-size: 13px;
      font-weight: 600;
    }

    .cms-count {
      font-size: 11px;
      color: var(--text-muted);
    }

    .cms-empty {
      margin: 0;
      padding: 10px 6px;
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
    }
  `,
})
export class ChecklistTemplateMultiSelectDropdownComponent {
  readonly templates = input.required<WireChecklistTemplate[]>();
  readonly selectedIds = input<string[]>([]);
  readonly placeholder = input("Choose checklists");
  readonly selectedIdsChange = output<string[]>();

  readonly open = signal(false);
  readonly query = signal("");
  readonly placement = { width: 320, maxHeight: 340, minHeight: 180, gap: 4, margin: 8 } as const;

  readonly selectedTemplates = computed(() => {
    const selected = new Set(this.selectedIds());
    return this.templates().filter((template) => selected.has(template.id));
  });

  readonly selectedLabel = computed(() => {
    const templates = this.selectedTemplates();
    if (templates.length === 0) return this.placeholder();
    if (templates.length <= 2) return templates.map((template) => template.title).join(", ");
    return `${templates[0]?.title}, ${templates[1]?.title} +${templates.length - 2}`;
  });

  readonly filteredTemplates = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.templates();
    return this.templates().filter((template) => template.title.toLowerCase().includes(q));
  });

  isSelected(templateId: string): boolean {
    return this.selectedIds().includes(templateId);
  }

  toggleOpen() {
    this.open.update((value) => !value);
  }

  toggleTemplate(templateId: string) {
    const selected = this.selectedIds();
    const next = selected.includes(templateId)
      ? selected.filter((id) => id !== templateId)
      : [...selected, templateId];
    this.selectedIdsChange.emit(next);
  }

}
