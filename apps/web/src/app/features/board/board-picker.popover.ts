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
import type { WireBoard } from "@kanera/shared/events";
import { ApiClient } from "../../core/api/api.client";

@Component({
  selector: "k-board-picker",
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bp-panel" (click)="$event.stopPropagation()">
      <div class="bp-head">
        <span class="bp-title">{{ title() }}</span>
      </div>
      <input
        class="bp-search"
        type="text"
        placeholder="Search boards…"
        [value]="query()"
        (input)="query.set($any($event.target).value)"
      />
      <div class="bp-list">
        @if (loading()) {
          <p class="bp-empty">Loading…</p>
        } @else if (filtered().length === 0) {
          <p class="bp-empty">No other boards</p>
        }
        @for (b of filtered(); track b.id) {
          <button type="button" class="bp-row" (click)="pick.emit(b.id)">
            <i
              [class]="'ti ti-' + (b.icon || 'layout-board')"
              [style.color]="b.iconColor ? 'var(--color-' + b.iconColor + ')' : null"
            ></i>
            <span class="bp-name">{{ b.name }}</span>
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

    .bp-panel {
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
      padding: 10px;
      width: 280px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .bp-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .bp-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .bp-search {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      padding: 6px 8px;
      font-size: 13px;
      outline: none;
      &:focus { border-color: var(--accent, var(--text)); }
    }

    .bp-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 260px;
      overflow-y: auto;
    }

    .bp-empty {
      color: var(--text-muted);
      font-size: 12px;
      margin: 0;
      padding: 8px 4px;
      text-align: center;
    }

    .bp-row {
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
      font-size: 13px;
      &:hover { background: var(--surface-2); }
    }

    .bp-row i {
      font-size: 16px;
      width: 18px;
      text-align: center;
    }

    .bp-name {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `,
})
export class BoardPickerPopover implements AfterViewInit, OnDestroy {
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly api = inject(ApiClient);

  readonly sourceBoardId = input.required<string>();
  readonly excludeBoardId = input.required<string>();
  readonly title = input<string>("Pick a board");
  readonly pick = output<string>();
  readonly close = output<void>();

  readonly query = signal("");
  readonly loading = signal(true);
  readonly boards = signal<WireBoard[]>([]);

  private anchorEl: HTMLElement | null = null;
  private readonly reposition = () => this.position();

  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const exclude = this.excludeBoardId();
    const list = this.boards()
      .filter((b) => b.id !== exclude)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!q) return list;
    return list.filter((b) => b.name.toLowerCase().includes(q));
  });

  ngAfterViewInit() {
    this.anchorEl = this.hostEl.nativeElement.parentElement;
    this.position();
    window.addEventListener("resize", this.reposition);
    window.addEventListener("scroll", this.reposition, true);
    void this.load();
  }

  ngOnDestroy() {
    window.removeEventListener("resize", this.reposition);
    window.removeEventListener("scroll", this.reposition, true);
  }

  private async load() {
    try {
      const boards = await this.api.get<WireBoard[]>(`/boards/${this.sourceBoardId()}/transfer-targets`);
      this.boards.set(boards);
    } finally {
      this.loading.set(false);
      queueMicrotask(() => this.position());
    }
  }

  private position() {
    if (!this.anchorEl) return;
    const host = this.hostEl.nativeElement;
    const rect = this.anchorEl.getBoundingClientRect();
    const panelWidth = 280;
    const margin = 8;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let left = rect.right - panelWidth;
    if (left < margin) left = margin;
    if (left + panelWidth > viewportW - margin) left = viewportW - panelWidth - margin;

    const panelHeight = host.offsetHeight || 320;
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
