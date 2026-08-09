import { ChangeDetectionStrategy, Component, computed, input, output, signal } from "@angular/core";
import { AvatarComponent } from "../../shared/avatar.component";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";

export type UserMultiSelectOption = {
  userId: string;
  displayName: string;
  email?: string;
  avatarUrl: string | null;
};

@Component({
  selector: "k-user-multi-select-dropdown",
  standalone: true,
  imports: [AnchoredPanelDirective, AvatarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ums">
      <button #trigger type="button" class="ums-trigger" [class.is-open]="open()" (click)="toggleOpen()" [attr.aria-expanded]="open()" aria-haspopup="listbox">
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
          class="ums-panel"
          kAnchoredPanel
          [apAnchor]="trigger"
          [apPlacement]="placement"
          (apDismissed)="open.set(false)"
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

    /* --field-bg lets the host seat this trigger at the same depth as its native selects; hosts that
       do not set it keep the previous --surface-2 fill. */
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
      background: var(--field-bg, var(--surface-2));
      color: var(--text);
      cursor: pointer;
      text-align: left;
      font-size: 13px;

      &:hover,
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
export class UserMultiSelectDropdownComponent {
  readonly users = input.required<UserMultiSelectOption[]>();
  readonly selectedIds = input<string[]>([]);
  readonly placeholder = input("Choose users");
  readonly workspaceId = input<string | null>(null);
  readonly allowEmpty = input(false);
  /**
   * null = unbounded. 1 makes this a single-select (picking replaces the current choice), which the
   * automation editor needs for a populate_custom_field action on a user field that is not multiple —
   * appending there would build a selection the API rejects.
   */
  readonly max = input<number | null>(null);
  readonly selectedIdsChange = output<string[]>();

  readonly open = signal(false);
  readonly query = signal("");
  readonly placement = { width: 320, maxHeight: 340, minHeight: 180, gap: 4, margin: 8 } as const;

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

  toggleOpen() {
    this.open.update((value) => !value);
  }

  toggleUser(userId: string) {
    const selected = this.selectedIds();
    if (!selected.includes(userId) && this.max() === 1) {
      this.selectedIdsChange.emit([userId]);
      this.open.set(false);
      return;
    }
    const next = selected.includes(userId)
      ? selected.filter((id) => id !== userId)
      : [...selected, userId];
    if (!this.allowEmpty() && next.length === 0) return;
    const max = this.max();
    if (max !== null && next.length > max) return;
    this.selectedIdsChange.emit(next);
  }

}
