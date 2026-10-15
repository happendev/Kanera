import { CdkDrag, CdkDragHandle, CdkDropList } from "@angular/cdk/drag-drop";
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import type { WireAutomation } from "@kanera/shared/events";
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
    label: $localize`:Group heading in the automation event picker:Movement`,
    icon: "arrows-transfer-up",
    options: [
      { id: "card_enters_list", label: $localize`:Automation event (trigger) option:Card enters a list`, hint: $localize`:Help text under an automation event option:Created in or moved into a list`, icon: "login-2" },
      { id: "card_leaves_list", label: $localize`:Automation event (trigger) option:Card leaves a list`, hint: $localize`:Help text under an automation event option:Moved out of a list, even across boards`, icon: "logout-2" },
    ],
  },
  {
    id: "time",
    label: $localize`:Group heading in the automation event picker:Dates & time`,
    icon: "calendar-time",
    options: [
      { id: "due_date_arrives", label: $localize`:Automation event (trigger) option:Due date arrives`, hint: $localize`:Help text under an automation event option:Runs on the card's due date`, icon: "calendar-event" },
      { id: "due_date_approaching", label: $localize`:Automation event (trigger) option:Due date is approaching`, hint: $localize`:Help text under an automation event option:Runs a chosen number of days before`, icon: "calendar-due" },
      { id: "card_becomes_inactive", label: $localize`:Automation event (trigger) option:Card becomes inactive`, hint: $localize`:Help text under an automation event option:Runs after the workspace inactivity period`, icon: "clock-pause" },
      { id: "card_in_progress_too_long", label: $localize`:Automation event (trigger) option:Card in progress too long`, hint: $localize`:Help text under an automation event option:Runs when time in progress passes the workspace alert`, icon: "progress-alert" },
    ],
  },
  {
    id: "card-updates",
    label: $localize`:Group heading in the automation event picker:Card updates`,
    icon: "activity",
    options: [
      { id: "all_checklist_items_complete", label: $localize`:Automation event (trigger) option:All checklist items complete`, hint: $localize`:Help text under an automation event option:The final unticked item is completed`, icon: "checklist" },
      { id: "card_assigned_to_user", label: $localize`:Automation event (trigger) option:Card assigned to a member`, hint: $localize`:Help text under an automation event option:One of the selected members is assigned`, icon: "user-plus" },
      { id: "card_marked_complete", label: $localize`:Automation event (trigger) option:Card marked complete`, hint: $localize`:Help text under an automation event option:The card's completed state is turned on`, icon: "circle-check" },
      { id: "card_label_set", label: $localize`:Automation event (trigger) option:Label added to a card`, hint: $localize`:Help text under an automation event option:A selected label is applied`, icon: "tag" },
      { id: "custom_field_value_changed", label: $localize`:Automation event (trigger) option:Custom field changes to a value`, hint: $localize`:Help text under an automation event option:A field reaches the value you choose`, icon: "forms" },
    ],
  },
] satisfies PickerGroup[];

const automationActionPickerGroups = [
  {
    id: "organize",
    label: $localize`:Group heading in the automation action picker:Move & organize`,
    icon: "arrows-move",
    options: [
      { id: "move_to_list", label: $localize`:Automation action option:Move to a list`, hint: $localize`:Help text under an automation action option:Choose the destination and its top or bottom`, icon: "arrow-big-right-lines" },
      { id: "move_to_top", label: $localize`:Automation action option:Move to top`, hint: $localize`:Help text under an automation action option:Put the card first in its current list`, icon: "arrow-bar-up" },
      { id: "move_to_bottom", label: $localize`:Automation action option:Move to bottom`, hint: $localize`:Help text under an automation action option:Put the card last in its current list`, icon: "arrow-bar-down" },
    ],
  },
  {
    id: "collaboration",
    label: $localize`:Group heading in the automation action picker:People & labels`,
    icon: "users-group",
    options: [
      { id: "add_labels", label: $localize`:Automation action option:Add labels`, hint: $localize`:Help text under an automation action option:Apply one or more card labels`, icon: "tags" },
      { id: "remove_labels", label: $localize`:Automation action option:Remove labels`, hint: $localize`:Help text under an automation action option:Remove one or more card labels`, icon: "tag-off" },
      { id: "add_assignees", label: $localize`:Automation action option:Add assignees`, hint: $localize`:Help text under an automation action option:Assign one or more members`, icon: "user-plus" },
      { id: "remove_assignees", label: $localize`:Automation action option:Remove assignees`, hint: $localize`:Help text under an automation action option:Unassign one or more members`, icon: "user-minus" },
    ],
  },
  {
    id: "card-data",
    label: $localize`:Group heading in the automation action picker:Card details`,
    icon: "file-pencil",
    options: [
      { id: "apply_checklists", label: $localize`:Automation action option:Apply a checklist`, hint: $localize`:Help text under an automation action option:Add items from checklist templates`, icon: "checklist" },
      { id: "set_due_date", label: $localize`:Automation action option:Set due date`, hint: $localize`:Help text under an automation action option:Schedule a date relative to the trigger`, icon: "calendar-plus" },
      { id: "clear_due_date", label: $localize`:Automation action option:Clear due date`, hint: $localize`:Help text under an automation action option:Remove the card's current due date`, icon: "calendar-off" },
      { id: "set_completion", label: $localize`:Automation action option:Set completion`, hint: $localize`:Help text under an automation action option:Mark the card complete or incomplete`, icon: "circle-check" },
      { id: "populate_custom_field", label: $localize`:Automation action option:Set custom field`, hint: $localize`:Help text under an automation action option:Write or copy a value into a field`, icon: "forms" },
    ],
  },
  {
    id: "outbound",
    label: $localize`:Group heading in the automation action picker:Notify & integrate`,
    icon: "send",
    options: [
      { id: "post_comment", label: $localize`:Automation action option:Post a comment`, hint: $localize`:Help text under an automation action option:Add a templated comment to the card`, icon: "message-plus" },
      { id: "call_webhook", label: $localize`:Automation action option:Call a webhook`, hint: $localize`:Help text under an automation action option:Send the card to a workspace webhook endpoint`, icon: "webhook" },
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

  protected readonly browseExamplesHint = $localize`:Tooltip on the Examples button:Browse example automations`;
  protected readonly collapseLabel = $localize`Collapse automation`;
  protected readonly expandLabel = $localize`Expand automation`;
  protected readonly duplicateLabel = $localize`Duplicate automation`;

  protected powerHint(automation: WireAutomation): string {
    if (automation.enabled) return $localize`Turn this automation off`;
    if (automation.actions.length === 0) return $localize`Add an action before turning this on`;
    if (this.settings.enabledAutomationLimitReached()) {
      return `${this.settings.enabledAutomationLimitHint() ?? ""} ${this.settings.planUpgradeHint}`;
    }
    return $localize`Turn this automation on`;
  }

  protected addActionLabel(automationId: string): string {
    return this.settings.canAddAutomationAction(automationId)
      ? $localize`:Button — add an action to the automation:Add action`
      : $localize`:Shown when an automation already has the most actions allowed:${this.settings.automationActionLimit}:limit: actions maximum`;
  }

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
