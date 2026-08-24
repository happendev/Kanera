import { ChangeDetectionStrategy, Component, computed, input, output, signal } from "@angular/core";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { AvatarComponent } from "../../shared/avatar.component";
import { PickerListComponent, type PickerGroup } from "../../shared/picker-list.component";

export type UserMultiSelectOption = {
  userId: string;
  displayName: string;
  email?: string;
  avatarUrl: string | null;
};

@Component({
  selector: "k-user-multi-select-dropdown",
  standalone: true,
  imports: [AnchoredPanelDirective, AvatarComponent, PickerListComponent],
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
          <k-picker-list
            [groups]="pickerGroups()"
            [selectedIds]="selectedIds()"
            [searchThreshold]="0"
            searchPlaceholder="Search users..."
            emptyLabel="No matching users"
            (pick)="toggleUser($event)"
          />
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

  /**
   * One ungrouped run of rows for `k-picker-list`, which owns the search, row markup, selected tick
   * and empty state. `searchThreshold` is 0 so the box is always present: these lists are workspace
   * membership, which is long enough that hunting by eye is the wrong interaction even at five rows.
   */
  readonly pickerGroups = computed<PickerGroup[]>(() => [{
    id: "users",
    options: this.users().map((user) => ({
      id: user.userId,
      label: user.displayName,
      hint: user.email ?? null,
      avatarUrl: user.avatarUrl,
      avatarName: user.displayName,
      avatarUserId: user.userId,
    })),
  }]);

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
