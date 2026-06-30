import type { OnDestroy } from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, ViewChild, computed, inject, input, output, signal } from "@angular/core";
import { AvatarComponent } from "../../shared/avatar.component";

export type UserMultiSelectOption = {
  userId: string;
  displayName: string;
  email?: string;
  avatarUrl: string | null;
};

type PanelPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

@Component({
  selector: "k-user-multi-select-dropdown",
  standalone: true,
  imports: [AvatarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ums" (click)="$event.stopPropagation()" (keydown.escape)="open.set(false)">
      <button type="button" class="ums-trigger" [class.is-open]="open()" (click)="toggleOpen($event)" [attr.aria-expanded]="open()" aria-haspopup="listbox">
        @if (selectedUsers().length) {
          <span class="ums-selected-stack" aria-hidden="true">
            @for (user of selectedUsers().slice(0, 3); track user.userId) {
              <k-avatar [url]="user.avatarUrl" [name]="user.displayName" [size]="22" [userId]="user.userId" [workspaceId]="workspaceId()" />
            }
          </span>
          <span class="ums-label">{{ selectedLabel() }}</span>
        } @else {
          <i class="ti ti-users"></i>
          <span class="ums-label">{{ placeholder() }}</span>
        }
        <i class="ti ti-chevron-down ums-chevron"></i>
      </button>

      @if (open()) {
        <div
          #panel
          class="ums-panel"
          [style.top.px]="panelPosition().top"
          [style.left.px]="panelPosition().left"
          [style.width.px]="panelPosition().width"
          [style.max-height.px]="panelPosition().maxHeight"
        >
          <input
            class="ums-search"
            type="text"
            placeholder="Search users..."
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
          <div class="ums-list" role="listbox" aria-multiselectable="true">
            @if (filteredUsers().length === 0) {
              <p class="ums-empty">No matching users</p>
            }
            @for (user of filteredUsers(); track user.userId) {
              <button type="button" class="ums-row" [class.is-selected]="isSelected(user.userId)" (click)="toggleUser(user.userId)" role="option" [attr.aria-selected]="isSelected(user.userId)">
                <k-avatar [url]="user.avatarUrl" [name]="user.displayName" [size]="24" [userId]="user.userId" [workspaceId]="workspaceId()" />
                <span class="ums-user">
                  <span class="ums-name">{{ user.displayName }}</span>
                  @if (user.email) {
                    <span class="ums-email">{{ user.email }}</span>
                  }
                </span>
                @if (isSelected(user.userId)) {
                  <i class="ti ti-check ums-check"></i>
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

    .ums-trigger {
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

    .ums-trigger > i:not(.ums-chevron) {
      color: var(--text-muted);
      font-size: 15px;
    }

    .ums-selected-stack {
      display: inline-flex;
      align-items: center;
      flex: 0 0 auto;

      k-avatar + k-avatar {
        margin-left: -7px;
      }
    }

    .ums-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ums-chevron {
      color: var(--text-muted);
      font-size: 14px;
      flex: 0 0 auto;
    }

    .ums-panel {
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

    .ums-search {
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

    .ums-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-height: 0;
      overflow-y: auto;
    }

    .ums-row {
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

    .ums-user {
      flex: 1;
      min-width: 0;
      display: grid;
      gap: 1px;
    }

    .ums-name,
    .ums-email {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ums-name {
      font-size: 13px;
      font-weight: 600;
    }

    .ums-email {
      font-size: 11px;
      color: var(--text-muted);
    }

    .ums-check {
      color: var(--accent, var(--text));
      font-size: 15px;
      flex: 0 0 auto;
    }

    .ums-empty {
      margin: 0;
      padding: 10px 6px;
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
    }
  `,
})
export class UserMultiSelectDropdownComponent implements OnDestroy {
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly users = input.required<UserMultiSelectOption[]>();
  readonly selectedIds = input<string[]>([]);
  readonly placeholder = input("Choose users");
  readonly workspaceId = input<string | null>(null);
  readonly allowEmpty = input(false);
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

  readonly selectedUsers = computed(() => {
    const selected = new Set(this.selectedIds());
    return this.users().filter((user) => selected.has(user.userId));
  });

  readonly selectedLabel = computed(() => {
    const users = this.selectedUsers();
    if (users.length === 0) return this.placeholder();
    if (users.length <= 2) return users.map((user) => user.displayName).join(", ");
    return `${users[0]?.displayName}, ${users[1]?.displayName} +${users.length - 2}`;
  });

  readonly filteredUsers = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.users();
    return this.users().filter((user) =>
      user.displayName.toLowerCase().includes(q) ||
      (user.email?.toLowerCase().includes(q) ?? false),
    );
  });

  isSelected(userId: string): boolean {
    return this.selectedIds().includes(userId);
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

  toggleUser(userId: string) {
    const selected = this.selectedIds();
    const next = selected.includes(userId)
      ? selected.filter((id) => id !== userId)
      : [...selected, userId];
    if (!this.allowEmpty() && next.length === 0) return;
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
    const trigger = this.hostEl.nativeElement.querySelector<HTMLElement>(".ums-trigger");
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
    // Keep the target height stable. Measuring the already constrained panel
    // during scroll feeds smaller heights back into the layout and makes it shrink.
    const desiredHeight = 340;
    const openBelow = availableBelow >= Math.min(desiredHeight, 180) || availableBelow >= availableAbove;
    const available = Math.max(120, openBelow ? availableBelow : availableAbove);
    const maxHeight = Math.min(desiredHeight, available);
    const top = openBelow
      ? rect.bottom + gap
      : Math.max(margin, rect.top - gap - maxHeight);

    this.panelPosition.set({ top, left, width, maxHeight });
  }

  private removePositionListeners() {
    window.removeEventListener("resize", this.reposition);
    window.removeEventListener("scroll", this.reposition, true);
  }
}
