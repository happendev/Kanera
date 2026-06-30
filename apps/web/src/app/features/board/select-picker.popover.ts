import type { AfterViewInit, OnDestroy } from "@angular/core";
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import type { WireCustomFieldOption } from "@kanera/shared/events";

// Option picker for `select` custom fields. Single vs multi selection is decided
// by the parent: it sets the resulting value and closes the popover for single fields.
@Component({
  selector: "k-select-picker",
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lp-panel" (click)="$event.stopPropagation()">
      <div class="lp-head">
        <span class="lp-title">{{ title() }}</span>
        @if (allowMultiple()) {
          <span class="lp-hint">Multiple</span>
        }
      </div>
      <input
        class="lp-search"
        type="text"
        placeholder="Search options…"
        [value]="query()"
        (input)="query.set($any($event.target).value)"
        autofocus
      />
      <div class="lp-list">
        @if (filtered().length === 0) {
          <p class="lp-empty">No matching options</p>
        }
        @for (option of filtered(); track option.id) {
          <button
            type="button"
            class="lp-row"
            [class.is-selected]="selectedIds().includes(option.id)"
            (click)="toggle.emit(option.id)"
          >
            <span
              class="lp-dot"
              [style.background]="option.color ? 'var(--color-' + option.color + ')' : 'var(--border-strong)'"
            ></span>
            <span class="lp-name">{{ option.label }}</span>
            @if (selectedIds().includes(option.id)) {
              <i class="ti ti-check lp-check"></i>
            }
          </button>
        }
      </div>
      @if (selectedIds().length) {
        <button type="button" class="lp-clear" (click)="clear.emit()">Clear</button>
      }
    </div>
  `,
  styles: `
    :host {
      position: fixed;
      z-index: 300;
      visibility: hidden;
    }

    :host(.is-positioned) {
      visibility: visible;
    }

    .lp-panel {
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
      padding: 10px;
      width: 260px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .lp-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .lp-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .lp-hint {
      font-size: 11px;
      color: var(--text-muted);
    }

    .lp-search {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      padding: 6px 8px;
      font-size: 13px;
      outline: none;
      &:focus { border-color: var(--accent, var(--text)); }
    }

    .lp-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 280px;
      overflow-y: auto;
    }

    .lp-empty {
      color: var(--text-muted);
      font-size: 12px;
      margin: 0;
      padding: 8px 4px;
      text-align: center;
    }

    .lp-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      background: transparent;
      border: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      color: var(--text);
      text-align: left;
      width: 100%;
      transition: background-color 0.12s;
      &:hover { background: var(--surface-2); }
      &.is-selected { background: var(--surface-2); }
    }

    .lp-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex: 0 0 12px;
    }

    .lp-name {
      flex: 1;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .lp-check {
      color: var(--accent, var(--text));
      font-size: 14px;
    }

    .lp-clear {
      background: transparent;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      padding: 5px 8px;
      font-size: 12px;
      cursor: pointer;
      &:hover { background: var(--surface-2); color: var(--text); }
    }
  `,
})
export class SelectPickerPopover implements AfterViewInit, OnDestroy {
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly options = input.required<WireCustomFieldOption[]>();
  readonly selectedIds = input<string[]>([]);
  readonly allowMultiple = input(false);
  readonly title = input("Options");
  readonly toggle = output<string>();
  readonly clear = output<void>();
  readonly close = output<void>();

  readonly query = signal("");

  private anchorEl: HTMLElement | null = null;
  private readonly reposition = () => this.position();

  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const sorted = [...this.options()].sort((a, b) => Number(a.position) - Number(b.position));
    if (!q) return sorted;
    return sorted.filter((o) => o.label.toLowerCase().includes(q));
  });

  ngAfterViewInit() {
    this.anchorEl = this.hostEl.nativeElement.parentElement;
    this.position();
    window.addEventListener("resize", this.reposition);
    window.addEventListener("scroll", this.reposition, true);
  }

  ngOnDestroy() {
    window.removeEventListener("resize", this.reposition);
    window.removeEventListener("scroll", this.reposition, true);
  }

  private position() {
    if (!this.anchorEl) return;
    const host = this.hostEl.nativeElement;
    const rect = this.anchorEl.getBoundingClientRect();
    const panelWidth = 260;
    const margin = 8;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let left = rect.right - panelWidth;
    if (left < margin) left = margin;
    if (left + panelWidth > viewportW - margin) left = viewportW - panelWidth - margin;

    const panelHeight = host.offsetHeight || 340;
    let top = rect.bottom + 4;
    if (top + panelHeight > viewportH - margin) {
      const above = rect.top - 4 - panelHeight;
      if (above >= margin) top = above;
      else top = Math.max(margin, viewportH - panelHeight - margin);
    }

    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
    host.classList.add("is-positioned");
  }

  @HostListener("document:click")
  onDocumentClick() {
    this.close.emit();
  }
}
