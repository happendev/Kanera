import type { AfterViewInit, OnDestroy, OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, input, output, signal } from "@angular/core";
import { AuthService } from "../../core/auth/auth.service";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { AvatarComponent } from "../../shared/avatar.component";

@Component({
  selector: "k-watcher-popover",
  standalone: true,
  imports: [AvatarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wp-panel" (click)="$event.stopPropagation()">
      @if (showToggle()) {
      <button type="button" class="wp-toggle" (click)="toggleWatching()" [disabled]="toggling()">
        <i [class]="isWatching() ? 'ti ti-eye-off' : 'ti ti-eye'"></i>
        <span>{{ isWatching() ? stopLabel() : watchLabel() }}</span>
      </button>
      }

      <div class="wp-title">{{ title() }}</div>
      @if (loading()) {
      <p class="wp-empty">Loading watchers...</p>
      } @else if (error()) {
      <p class="wp-empty">Could not load watchers</p>
      } @else if (watchers().length === 0) {
      <p class="wp-empty">No watchers</p>
      } @else {
      <div class="wp-list">
        @for (watcher of watchers(); track watcher.userId) {
        <div class="wp-row">
          <k-avatar [url]="watcher.avatarUrl" [name]="watcher.displayName" [size]="28" [userId]="watcher.userId" [workspaceId]="workspaceId()" [showPresence]="true" />
          <span class="wp-name">{{ watcher.userId === currentUserId() ? 'Me' : watcher.displayName }}</span>
        </div>
        }
      </div>
      }
    </div>
  `,
  styles: `
    :host {
      position: fixed;
      z-index: 500;
      display: block;
      visibility: hidden;
    }

    :host(.is-positioned) {
      visibility: visible;
    }

    .wp-panel {
      width: 280px;
      padding: 10px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      background: var(--surface);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
    }

    .wp-toggle {
      width: 100%;
      min-height: 36px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface-2);
      color: var(--text);
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }

    .wp-toggle:hover:not(:disabled) {
      background: var(--surface-hover);
      border-color: var(--border-strong);
    }

    .wp-toggle:disabled {
      cursor: progress;
      opacity: 0.7;
    }

    .wp-title {
      margin: 10px 4px 4px;
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    .wp-list {
      max-height: 190px;
      overflow-y: auto;
      padding-right: 2px;
    }

    .wp-row {
      min-height: 36px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 6px;
      border-radius: var(--radius-sm);
    }

    .wp-row:hover {
      background: var(--surface-2);
    }

    .wp-name {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      color: var(--text);
      font-size: 13px;
      font-weight: 500;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .wp-empty {
      margin: 0;
      padding: 8px 6px;
      color: var(--text-muted);
      font-size: 12px;
    }
  `,
})
export class WatcherPopoverComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly auth = inject(AuthService);
  private readonly notifications = inject(NotificationsService);
  private anchorEl: HTMLElement | null = null;
  private readonly reposition = () => this.position();

  readonly kind = input.required<"board" | "card">();
  readonly entityId = input.required<string>();
  readonly workspaceId = input<string | null>(null);
  readonly showToggle = input(true);
  readonly dismissed = output<void>();

  readonly loading = signal(false);
  readonly error = signal(false);
  readonly toggling = signal(false);
  readonly currentUserId = computed(() => this.auth.user()?.id ?? null);
  readonly watchers = computed(() => {
    const id = this.entityId();
    return this.kind() === "board"
      ? this.notifications.boardWatchers()[id] ?? []
      : this.notifications.cardWatchers()[id] ?? [];
  });
  readonly isWatching = computed(() => {
    const id = this.entityId();
    return this.kind() === "board"
      ? this.notifications.isWatchingBoard(id)
      : this.notifications.isWatchingCard(id);
  });
  readonly title = computed(() => this.kind() === "board" ? "Board watchers" : "Card watchers");
  readonly watchLabel = computed(() => this.kind() === "board" ? "Watch board" : "Watch card");
  readonly stopLabel = computed(() => this.kind() === "board" ? "Stop watching board" : "Stop watching card");

  ngOnInit(): void {
    void this.load();
  }

  ngAfterViewInit(): void {
    this.anchorEl = this.hostEl.nativeElement.parentElement;
    this.position();
    window.addEventListener("resize", this.reposition);
    window.addEventListener("scroll", this.reposition, true);
  }

  ngOnDestroy(): void {
    window.removeEventListener("resize", this.reposition);
    window.removeEventListener("scroll", this.reposition, true);
  }

  async toggleWatching(): Promise<void> {
    if (this.toggling()) return;
    this.toggling.set(true);
    try {
      if (this.kind() === "board") await this.notifications.toggleBoardWatch(this.entityId());
      else await this.notifications.toggleCardWatch(this.entityId());
    } finally {
      this.toggling.set(false);
    }
  }

  @HostListener("document:click")
  onDocumentClick(): void {
    this.dismissed.emit();
  }

  @HostListener("document:keydown.escape")
  onEscape(): void {
    this.dismissed.emit();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    try {
      if (this.kind() === "board") await this.notifications.loadBoardWatchers(this.entityId());
      else await this.notifications.loadCardWatchers(this.entityId());
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
      queueMicrotask(() => this.position());
    }
  }

  private position(): void {
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

    const panelHeight = host.offsetHeight || 260;
    let top = rect.bottom + 6;
    if (top + panelHeight > viewportH - margin) {
      const above = rect.top - 6 - panelHeight;
      top = above >= margin ? above : Math.max(margin, viewportH - panelHeight - margin);
    }

    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
    host.classList.add("is-positioned");
  }
}
