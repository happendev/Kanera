import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";
import type { WireChecklistTemplate } from "@kanera/shared/events";
import { MultiSelectDropdownComponent } from "../../shared/multi-select-dropdown.component";
import type { PickerGroup } from "../../shared/picker-list.component";

@Component({
  selector: "k-checklist-template-multi-select-dropdown",
  standalone: true,
  imports: [MultiSelectDropdownComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <k-multi-select-dropdown
      [groups]="pickerGroups()"
      [selectedIds]="selectedIds()"
      [label]="selectedLabel()"
      [searchThreshold]="0"
      searchPlaceholder="Search checklists..."
      emptyLabel="No matching checklists"
      (pick)="toggleTemplate($event)"
    >
      <i class="ti ti-list-check"></i>
    </k-multi-select-dropdown>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
  `,
})
export class ChecklistTemplateMultiSelectDropdownComponent {
  readonly templates = input.required<WireChecklistTemplate[]>();
  readonly selectedIds = input<string[]>([]);
  readonly placeholder = input("Choose checklists");
  readonly selectedIdsChange = output<string[]>();

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

  toggleTemplate(templateId: string) {
    const selected = this.selectedIds();
    const next = selected.includes(templateId)
      ? selected.filter((id) => id !== templateId)
      : [...selected, templateId];
    this.selectedIdsChange.emit(next);
  }
}
