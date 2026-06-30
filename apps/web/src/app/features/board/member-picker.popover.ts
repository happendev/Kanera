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
import type { WireBoardMemberUser } from "@kanera/shared/events";
import { AvatarComponent } from "../../shared/avatar.component";

@Component({
  selector: "k-member-picker",
  standalone: true,
  imports: [AvatarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mp-panel" (click)="$event.stopPropagation()">
      <div class="mp-head">
        <span class="mp-title">Assigned Members</span>
      </div>
      <input
        class="mp-search"
        type="text"
        placeholder="Search members…"
        [value]="query()"
        (input)="query.set($any($event.target).value)"
      />
      <div class="mp-list">
        @if (filtered().length === 0) {
          <p class="mp-empty">No matching members</p>
        }
        @for (m of filtered(); track m.userId) {
          <button
            type="button"
            class="mp-row"
            [class.is-selected]="selectedIds().includes(m.userId)"
            (click)="toggle.emit(m.userId)"
          >
            <span class="mp-avatar">
              <k-avatar [url]="m.avatarUrl" [name]="m.displayName" [size]="24" [userId]="m.userId" [workspaceId]="workspaceId()" [showPresence]="true" [lastOnlineAt]="m.lastOnlineAt" />
            </span>
            <span class="mp-name">{{ m.userId === currentUserId() ? 'Me' : m.displayName }}</span>
            @if (selectedIds().includes(m.userId)) {
              <i class="ti ti-check mp-check"></i>
            }
          </button>
        }
      </div>
      @if (allowClear() && selectedIds().length) {
        <button type="button" class="mp-clear" (click)="clear.emit()">
          <i class="ti ti-user-x"></i>
          {{ clearLabel() }}
        </button>
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

    .mp-panel {
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

    .mp-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .mp-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .mp-search {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      padding: 6px 8px;
      font-size: 13px;
      outline: none;
      &:focus { border-color: var(--accent, var(--text)); }
    }

    .mp-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 260px;
      overflow-y: auto;
    }

    .mp-empty {
      color: var(--text-muted);
      font-size: 12px;
      margin: 0;
      padding: 8px 4px;
      text-align: center;
    }

    .mp-row {
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

    .mp-avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      flex: 0 0 28px;
      border-radius: 50%;
      background: var(--surface-hover);
      color: var(--text);
      font-size: 12px;
      font-weight: 600;
      border: 1px solid var(--border);
      img { width: 100%; height: 100%; object-fit: cover; display: block; }
    }

    .mp-name {
      flex: 1;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .mp-check {
      color: var(--accent, var(--text));
      font-size: 14px;
    }

    .mp-clear {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 7px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 13px;
      text-align: left;
      &:hover {
        background: var(--surface-2);
        color: var(--text);
      }
    }
  `,
})
export class MemberPickerPopover implements AfterViewInit, OnDestroy {
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly members = input.required<WireBoardMemberUser[]>();
  readonly selectedIds = input<string[]>([]);
  readonly pinnedIds = input<string[]>([]);
  readonly currentUserId = input<string | null | undefined>(null);
  readonly workspaceId = input<string | null>(null);
  readonly allowClear = input(false);
  readonly clearLabel = input("Clear selection");
  readonly toggle = output<string>();
  readonly clear = output<void>();
  readonly close = output<void>();

  readonly query = signal("");

  private anchorEl: HTMLElement | null = null;
  private readonly reposition = () => this.position();

  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const meId = this.currentUserId();
    const pinned = new Set(this.pinnedIds());
    const sorted = this.members().filter((member) => member.role !== "observer").sort((a, b) => {
      const aPinned = pinned.has(a.userId);
      const bPinned = pinned.has(b.userId);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      if (a.userId === meId) return -1;
      if (b.userId === meId) return 1;
      return a.displayName.localeCompare(b.displayName);
    });
    if (!q) return sorted;
    return sorted.filter((m) => m.displayName.toLowerCase().includes(q) || (m.userId === meId && "me".includes(q)));
  });

  initialFor(name: string): string {
    return (name || "?").charAt(0).toUpperCase();
  }

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
