import type {
  AfterViewInit,
  OnDestroy} from "@angular/core";
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
import type { WireCardLabel } from "@kanera/shared/events";
import type { CardLabel } from "@kanera/shared/schema";

@Component({
  selector: "k-label-picker",
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lp-panel" (click)="$event.stopPropagation()">
      <div class="lp-head">
        <span class="lp-title">Labels</span>
      </div>
      <input
        class="lp-search"
        type="text"
        placeholder="Search labels…"
        [value]="query()"
        (input)="query.set($any($event.target).value)"
        autofocus
      />
      <div class="lp-list">
        @if (filtered().length === 0) {
          <p class="lp-empty">No matching labels</p>
        }
        @for (label of filtered(); track label.id) {
          <button
            type="button"
            class="lp-row"
            [class.is-selected]="selectedIds().includes(label.id)"
            (click)="toggle.emit(label.id)"
          >
            <span
              class="lp-dot"
              [style.background]="label.color ? 'var(--color-' + label.color + ')' : 'var(--border-strong)'"
            ></span>
            <span class="lp-name">{{ label.name }}</span>
            @if (selectedIds().includes(label.id)) {
              <i class="ti ti-check lp-check"></i>
            }
          </button>
        }
      </div>
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
    }

    .lp-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      text-transform: uppercase;
      letter-spacing: 0.04em;
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
  `,
})
export class LabelPickerPopover implements AfterViewInit, OnDestroy {
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly labels = input.required<(CardLabel | WireCardLabel)[]>();
  readonly selectedIds = input<string[]>([]);
  readonly toggle = output<string>();
  readonly close = output<void>();

  readonly query = signal("");

  private anchorEl: HTMLElement | null = null;
  private readonly reposition = () => this.position();

  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const sorted = [...this.labels()].sort((a, b) =>
      Number(a.position) - Number(b.position),
    );
    if (!q) return sorted;
    return sorted.filter((l) => l.name.toLowerCase().includes(q));
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
