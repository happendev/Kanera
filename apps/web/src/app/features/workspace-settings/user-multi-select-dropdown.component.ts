import { ChangeDetectionStrategy, Component, computed, input, output, viewChild } from "@angular/core";
import { AvatarComponent } from "../../shared/avatar.component";
import { MultiSelectDropdownComponent } from "../../shared/multi-select-dropdown.component";
import type { PickerGroup } from "../../shared/picker-list.component";

export type UserMultiSelectOption = {
  userId: string;
  displayName: string;
  email?: string;
  avatarUrl: string | null;
};

@Component({
  selector: "k-user-multi-select-dropdown",
  standalone: true,
  imports: [AvatarComponent, MultiSelectDropdownComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <k-multi-select-dropdown
      [groups]="pickerGroups()"
      [selectedIds]="selectedIds()"
      [label]="selectedLabel()"
      [searchThreshold]="0"
      searchPlaceholder="Search users..."
      emptyLabel="No matching users"
      (pick)="toggleUser($event)"
    >
      @if (selectedUsers().length) {
        <span class="ums-selected-stack" aria-hidden="true">
          @for (user of selectedUsers().slice(0, 3); track user.userId) {
            <k-avatar [url]="user.avatarUrl" [name]="user.displayName" [size]="22" [userId]="user.userId" [workspaceId]="workspaceId()" />
          }
        </span>
      } @else {
        <i class="ti ti-users"></i>
      }
    </k-multi-select-dropdown>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }

    .ums-selected-stack {
      display: inline-flex;
      align-items: center;
      flex: 0 0 auto;

      k-avatar + k-avatar {
        margin-left: -7px;
      }
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

  private readonly dropdown = viewChild.required(MultiSelectDropdownComponent);

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

  toggleUser(userId: string) {
    const selected = this.selectedIds();
    if (!selected.includes(userId) && this.max() === 1) {
      this.selectedIdsChange.emit([userId]);
      this.dropdown().close();
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
