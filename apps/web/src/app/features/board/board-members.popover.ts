import type { AfterViewInit, OnDestroy} from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, input, output } from "@angular/core";
import type { WireBoardMemberUser } from "@kanera/shared/events";
import { AvatarComponent } from "../../shared/avatar.component";

@Component({
  selector: "k-board-members-popover",
  standalone: true,
  imports: [AvatarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bmp-panel" (click)="$event.stopPropagation()">
      <section class="bmp-section">
        <div class="bmp-section-title">Workspace Members</div>
        @if (workspaceMembers().length === 0) {
          <p class="bmp-empty">No workspace members</p>
        }
        <div class="bmp-list">
        @for (member of workspaceMembers(); track member.userId) {
          <div class="bmp-row">
            <k-avatar [url]="member.avatarUrl" [name]="member.displayName" [size]="28" [userId]="member.userId" [workspaceId]="workspaceId()" [showPresence]="true" [lastOnlineAt]="member.lastOnlineAt" />
            <span class="bmp-name">{{ member.userId === currentUserId() ? 'Me' : member.displayName }}</span>
            <span class="bmp-role">{{ roleLabel(member.role) }}</span>
          </div>
        }
        </div>
      </section>

      <section class="bmp-section">
        <div class="bmp-section-title">Guests</div>
        @if (guests().length === 0) {
          <p class="bmp-empty">No guests on this board</p>
        }
        <div class="bmp-list">
        @for (guest of sortedGuests(); track guest.userId) {
          <div class="bmp-row">
            <k-avatar [url]="guest.avatarUrl" [name]="guest.displayName" [size]="28" [userId]="guest.userId" [workspaceId]="workspaceId()" [showPresence]="true" [lastOnlineAt]="guest.lastOnlineAt" />
            <span class="bmp-name">{{ guest.displayName }}</span>
            <span class="bmp-role">Guest</span>
          </div>
        }
        </div>
      </section>
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

    .bmp-panel {
      width: 320px;
      max-height: min(520px, calc(100vh - 24px));
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 12px;
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
    }

    .bmp-section {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .bmp-list {
      max-height: 180px;
      overflow-y: auto;
      padding-right: 2px;
    }

    .bmp-section-title {
      padding: 0 4px 4px;
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    .bmp-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 36px;
      padding: 5px 6px;
      border-radius: var(--radius-sm);
    }

    .bmp-row:hover {
      background: var(--surface-2);
    }

    .bmp-name {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      color: var(--text);
      font-size: 13px;
      font-weight: 500;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .bmp-role {
      flex: 0 0 auto;
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 600;
    }

    .bmp-empty {
      margin: 0;
      padding: 8px 6px;
      color: var(--text-muted);
      font-size: 12px;
    }
  `,
})
export class BoardMembersPopover implements AfterViewInit, OnDestroy {
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly workspaceMembers = input.required<WireBoardMemberUser[]>();
  readonly guests = input<WireBoardMemberUser[]>([]);
  readonly currentUserId = input<string | null | undefined>(null);
  readonly workspaceId = input<string | null>(null);
  readonly dismissed = output<void>();

  private anchorEl: HTMLElement | null = null;
  private readonly reposition = () => this.position();

  readonly sortedGuests = computed(() => [...this.guests()].sort((a, b) => a.displayName.localeCompare(b.displayName)));

  roleLabel(role: WireBoardMemberUser["role"]): string {
    return role.charAt(0).toUpperCase() + role.slice(1);
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
    const panelWidth = 320;
    const margin = 8;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let left = rect.left;
    if (left < margin) left = margin;
    if (left + panelWidth > viewportW - margin) left = viewportW - panelWidth - margin;

    const panelHeight = host.offsetHeight || 420;
    let top = rect.bottom + 6;
    if (top + panelHeight > viewportH - margin) {
      const above = rect.top - 6 - panelHeight;
      top = above >= margin ? above : Math.max(margin, viewportH - panelHeight - margin);
    }

    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
    host.classList.add("is-positioned");
  }

  @HostListener("document:click")
  onDocumentClick() {
    this.dismissed.emit();
  }
}
