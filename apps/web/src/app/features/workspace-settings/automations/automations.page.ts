import { CdkDrag, CdkDragHandle, CdkDropList } from "@angular/cdk/drag-drop";
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import type { PickerGroup } from "../../../shared/picker-list.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { BoardMenuCoordinator } from "../../board/board-menu-coordinator.service";
import { CardLabelsComponent } from "../../board/card-labels.component";
import { UserMultiSelectDropdownComponent } from "../user-multi-select-dropdown.component";
import { WorkspaceSettingsPage } from "../workspace-settings.page";
import { AutomationActionFieldsComponent } from "./automation-action-fields.component";
import { AutomationExamplesPopover } from "./automation-examples.popover";
import { AutomationSelectDropdownComponent } from "./automation-select-dropdown.component";

const automationEventPickerGroups = [
  {
    id: "movement",
    label: "Movement",
    icon: "arrows-transfer-up",
    options: [
      { id: "card_enters_list", label: "Card enters a list", hint: "Created in or moved into a list", icon: "login-2" },
      { id: "card_leaves_list", label: "Card leaves a list", hint: "Moved out of a list, even across boards", icon: "logout-2" },
    ],
  },
  {
    id: "time",
    label: "Dates & time",
    icon: "calendar-time",
    options: [
      { id: "due_date_arrives", label: "Due date arrives", hint: "Runs on the card's due date", icon: "calendar-event" },
      { id: "due_date_approaching", label: "Due date is approaching", hint: "Runs a chosen number of days before", icon: "calendar-due" },
      { id: "card_becomes_inactive", label: "Card becomes inactive", hint: "Runs after the workspace inactivity period", icon: "clock-pause" },
    ],
  },
  {
    id: "card-updates",
    label: "Card updates",
    icon: "activity",
    options: [
      { id: "all_checklist_items_complete", label: "All checklist items complete", hint: "The final unticked item is completed", icon: "checklist" },
      { id: "card_assigned_to_user", label: "Card assigned to a member", hint: "One of the selected members is assigned", icon: "user-plus" },
      { id: "card_marked_complete", label: "Card marked complete", hint: "The card's completed state is turned on", icon: "circle-check" },
      { id: "card_label_set", label: "Label added to a card", hint: "A selected label is applied", icon: "tag" },
      { id: "custom_field_value_changed", label: "Custom field changes to a value", hint: "A field reaches the value you choose", icon: "forms" },
    ],
  },
] satisfies PickerGroup[];

const automationActionPickerGroups = [
  {
    id: "organize",
    label: "Move & organize",
    icon: "arrows-move",
    options: [
      { id: "move_to_list", label: "Move to a list", hint: "Choose the destination and its top or bottom", icon: "arrow-big-right-lines" },
      { id: "move_to_top", label: "Move to top", hint: "Put the card first in its current list", icon: "arrow-bar-up" },
      { id: "move_to_bottom", label: "Move to bottom", hint: "Put the card last in its current list", icon: "arrow-bar-down" },
    ],
  },
  {
    id: "collaboration",
    label: "People & labels",
    icon: "users-group",
    options: [
      { id: "add_labels", label: "Add labels", hint: "Apply one or more card labels", icon: "tags" },
      { id: "remove_labels", label: "Remove labels", hint: "Remove one or more card labels", icon: "tag-off" },
      { id: "add_assignees", label: "Add assignees", hint: "Assign one or more members", icon: "user-plus" },
      { id: "remove_assignees", label: "Remove assignees", hint: "Unassign one or more members", icon: "user-minus" },
    ],
  },
  {
    id: "card-data",
    label: "Card details",
    icon: "file-pencil",
    options: [
      { id: "apply_checklists", label: "Apply a checklist", hint: "Add items from checklist templates", icon: "checklist" },
      { id: "set_due_date", label: "Set due date", hint: "Schedule a date relative to the trigger", icon: "calendar-plus" },
      { id: "clear_due_date", label: "Clear due date", hint: "Remove the card's current due date", icon: "calendar-off" },
      { id: "set_completion", label: "Set completion", hint: "Mark the card complete or incomplete", icon: "circle-check" },
      { id: "populate_custom_field", label: "Set custom field", hint: "Write or copy a value into a field", icon: "forms" },
    ],
  },
] satisfies PickerGroup[];

@Component({
  selector: "k-workspace-settings-automations",
  standalone: true,
  imports: [AutomationActionFieldsComponent, AutomationExamplesPopover, AutomationSelectDropdownComponent, CardLabelsComponent, CdkDrag, CdkDragHandle, CdkDropList, DocsLinkComponent, TooltipDirective, UserMultiSelectDropdownComponent],
  // k-card-labels reads the shared compressed-labels preference from BoardMenuCoordinator, which is
  // deliberately not root-provided (it owns document listeners torn down in ngOnDestroy). Providing
  // it here — as home.page.ts does for the same reason — scopes it to this tab, and the parent's
  // @switch destroys this component on tab change, so the listeners go with it.
  providers: [BoardMenuCoordinator],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./automations.page.html",
  styleUrl: "./automations.page.scss",
})
export class WorkspaceSettingsAutomationsPage {
  protected readonly settings = inject(WorkspaceSettingsPage);
  protected readonly eventPickerGroups = automationEventPickerGroups;
  protected readonly actionPickerGroups = automationActionPickerGroups;
  protected readonly listPickerGroups = computed<PickerGroup[]>(() => [{
    id: "lists",
    options: this.settings.lists().map(list => ({
      id: list.id,
      label: list.name,
      icon: "list",
    })),
  }]);

  /**
   * Which trigger the examples menu is anchored to, if any.
   *
   * Two anchors rather than one shared panel: the empty state's button sits well below the toolbar's,
   * and a menu that opened somewhere other than where it was clicked reads as a different control.
   */
  protected readonly examplesAnchor = signal<"toolbar" | "empty" | null>(null);

  constructor() {
    this.settings.selectedTab.set("automations");
  }

  protected toggleExamples(anchor: "toolbar" | "empty"): void {
    this.examplesAnchor.update((current) => (current === anchor ? null : anchor));
  }

  /**
   * Only clears when the panel that closed is still the open one. Clicking the other trigger
   * dismisses this panel *after* the new one has been recorded, and an unguarded set(null) there
   * would close the panel that click just opened.
   */
  protected closeExamples(anchor: "toolbar" | "empty"): void {
    this.examplesAnchor.update((current) => (current === anchor ? null : current));
  }
}
