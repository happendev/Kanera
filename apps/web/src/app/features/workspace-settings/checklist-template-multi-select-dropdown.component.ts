import { ChangeDetectionStrategy, Component, computed, input, output, signal } from "@angular/core";
import type { WireChecklistTemplate } from "@kanera/shared/events";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { PickerListComponent, type PickerGroup } from "../../shared/picker-list.component";

@Component({
  selector: "k-checklist-template-multi-select-dropdown",
  standalone: true,
  imports: [AnchoredPanelDirective, PickerListComponent],
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
          <k-picker-list
            [groups]="pickerGroups()"
            [selectedIds]="selectedIds()"
            [searchThreshold]="0"
            searchPlaceholder="Search checklists..."
            emptyLabel="No matching checklists"
            (pick)="toggleTemplate($event)"
          />
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

  `,
})
export class ChecklistTemplateMultiSelectDropdownComponent {
  readonly templates = input.required<WireChecklistTemplate[]>();
  readonly selectedIds = input<string[]>([]);
  readonly placeholder = input("Choose checklists");
  readonly selectedIdsChange = output<string[]>();

  readonly open = signal(false);
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

  /** Rows for `k-picker-list`, which owns the search, row markup, selected tick and empty state. */
  readonly pickerGroups = computed<PickerGroup[]>(() => [{
    id: "templates",
    options: this.templates().map((template) => ({
      id: template.id,
      label: template.title,
      icon: "list-check",
      trailing: `${template.items.length} ${template.items.length === 1 ? "item" : "items"}`,
    })),
  }]);

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
