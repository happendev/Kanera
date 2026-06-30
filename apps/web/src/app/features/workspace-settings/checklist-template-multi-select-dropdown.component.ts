import type { OnDestroy } from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, ViewChild, computed, inject, input, output, signal } from "@angular/core";
import type { WireChecklistTemplate } from "@kanera/shared/events";

type PanelPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

@Component({
  selector: "k-checklist-template-multi-select-dropdown",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cms" (click)="$event.stopPropagation()" (keydown.escape)="open.set(false)">
      <button type="button" class="cms-trigger" [class.is-open]="open()" (click)="toggleOpen($event)" [attr.aria-expanded]="open()" aria-haspopup="listbox">
        <i class="ti ti-list-check"></i>
        <span class="cms-label">{{ selectedLabel() }}</span>
        <i class="ti ti-chevron-down cms-chevron"></i>
      </button>

      @if (open()) {
        <div
          #panel
          class="cms-panel"
          [style.top.px]="panelPosition().top"
          [style.left.px]="panelPosition().left"
          [style.width.px]="panelPosition().width"
          [style.max-height.px]="panelPosition().maxHeight"
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
      background: var(--surface-2);
      color: var(--text);
      cursor: pointer;
      text-align: left;
      font-size: 13px;

      &:hover,
      &.is-open {
        border-color: var(--border-strong);
        background: var(--surface-hover);
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
      position: fixed;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 8px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius);
      background: var(--surface);
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
export class ChecklistTemplateMultiSelectDropdownComponent implements OnDestroy {
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly templates = input.required<WireChecklistTemplate[]>();
  readonly selectedIds = input<string[]>([]);
  readonly placeholder = input("Choose checklists");
  readonly selectedIdsChange = output<string[]>();

  readonly open = signal(false);
  readonly query = signal("");
  readonly panelPosition = signal<PanelPosition>({ top: 0, left: 0, width: 320, maxHeight: 320 });

  @ViewChild("panel")
  private readonly panel?: ElementRef<HTMLElement>;

  private readonly reposition = (event?: Event) => {
    if (event?.target instanceof Node && this.hostEl.nativeElement.contains(event.target)) return;
    this.positionPanel();
  };

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

  toggleOpen(event: MouseEvent) {
    event.stopPropagation();
    const nextOpen = !this.open();
    this.open.set(nextOpen);
    if (nextOpen) {
      this.positionPanel();
      requestAnimationFrame(() => this.positionPanel());
      window.addEventListener("resize", this.reposition);
      window.addEventListener("scroll", this.reposition, true);
    } else {
      this.removePositionListeners();
    }
  }

  toggleTemplate(templateId: string) {
    const selected = this.selectedIds();
    const next = selected.includes(templateId)
      ? selected.filter((id) => id !== templateId)
      : [...selected, templateId];
    this.selectedIdsChange.emit(next);
  }

  @HostListener("document:click")
  close() {
    this.open.set(false);
    this.removePositionListeners();
  }

  ngOnDestroy() {
    this.removePositionListeners();
  }

  private positionPanel() {
    if (!this.open()) return;
    const trigger = this.hostEl.nativeElement.querySelector<HTMLElement>(".cms-trigger");
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const width = Math.max(180, Math.min(320, viewportW - margin * 2));
    const left = Math.min(Math.max(rect.left, margin), Math.max(margin, viewportW - width - margin));
    const availableBelow = viewportH - rect.bottom - margin - gap;
    const availableAbove = rect.top - margin - gap;
    // When opening upward, position against the rendered panel height. A short
    // result list should sit just above the trigger, not reserve the full target
    // height and float halfway up the settings page.
    const renderedHeight = this.panel?.nativeElement.scrollHeight;
    const desiredHeight = Math.min(340, Math.max(96, renderedHeight ?? 180));
    // Keep the picker visually attached to the trigger. Near the bottom of a
    // long settings page, a full-height upward flip can make the panel appear
    // detached in the middle of the viewport, so only flip when below is truly
    // unusable and there is enough room above for a useful panel.
    const openBelow = availableBelow >= 96 || availableAbove < 180;
    const available = Math.max(96, openBelow ? availableBelow : availableAbove);
    const maxHeight = Math.min(desiredHeight, available);
    const top = openBelow
      ? Math.min(rect.bottom + gap, viewportH - margin - maxHeight)
      : Math.max(margin, rect.top - gap - maxHeight);

    this.panelPosition.set({ top, left, width, maxHeight });
  }

  private removePositionListeners() {
    window.removeEventListener("resize", this.reposition);
    window.removeEventListener("scroll", this.reposition, true);
  }
}
