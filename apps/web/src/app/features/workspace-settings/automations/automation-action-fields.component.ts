import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";
import type { AutomationActionBody } from "@kanera/shared/dto";
import { ChecklistTemplateMultiSelectDropdownComponent } from "../checklist-template-multi-select-dropdown.component";
import { TokenMultiSelectDropdownComponent } from "../token-multi-select-dropdown.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { UserMultiSelectDropdownComponent } from "../user-multi-select-dropdown.component";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

/**
 * The configuration fields of one Do step.
 *
 * Split out of the automations page because this is the part that varies by action type: the old
 * markup packed every variant into one positional CSS grid, so column three meant "label" on one row
 * and "list" on the next, and nothing carried a visible name. Here each control sits in its own
 * labelled `.aaf-field`, which also gives every native input an accessible name via the wrapping
 * `<label>`.
 *
 * State lives on WorkspaceSettingsPage (route-scoped, shared by every settings tab); this component
 * is a view over it, addressed by `automationId` + `index`.
 */
@Component({
  selector: "k-automation-action-fields",
  standalone: true,
  imports: [UserMultiSelectDropdownComponent, ChecklistTemplateMultiSelectDropdownComponent, TokenMultiSelectDropdownComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let a = action();

    @if (a.type === 'add_labels' || a.type === 'remove_labels') {
      <div class="aaf-field">
        <span class="aaf-label" i18n="Field label: card labels">Labels</span>
        @if (settings.labels().length) {
          <k-token-multi-select-dropdown
            icon="ti-tag"
            [options]="labelOptions()"
            [selectedIds]="settings.automationActionLabelIds(a)"
            placeholder="Choose labels"
            i18n-placeholder
            searchPlaceholder="Search labels..."
            i18n-searchPlaceholder
            emptyMessage="No labels match"
            i18n-emptyMessage
            ariaLabel="Labels"
            i18n-ariaLabel="Field label: card labels"
            (selectedIdsChange)="settings.updateAutomationActionLabels(automationId(), index(), $event)"
          />
        } @else {
          <p class="aaf-missing" i18n>{ settings.entityKind(), select, board {This board has no labels yet.} other {This workspace has no labels yet.} }</p>
        }
      </div>
    } @else if (a.type === 'add_assignees' || a.type === 'remove_assignees') {
      <div class="aaf-field">
        <span class="aaf-label" i18n="Field label">Members</span>
        <k-user-multi-select-dropdown
          [users]="settings.automationMembers()"
          [selectedIds]="settings.automationActionUserIds(a)"
          [workspaceId]="settings.workspaceId()"
          [allowEmpty]="true"
          placeholder="Choose members"
          i18n-placeholder
          (selectedIdsChange)="settings.updateAutomationActionAssignees(automationId(), index(), $event)"
        />
      </div>
    } @else if (a.type === 'apply_checklists') {
      <div class="aaf-field">
        <span class="aaf-label" i18n="Field label">Checklist templates</span>
        @if (settings.templates().length) {
          <k-checklist-template-multi-select-dropdown
            [templates]="settings.templates()"
            [selectedIds]="settings.automationActionTemplateIds(a)"
            placeholder="Choose checklists"
            i18n-placeholder
            (selectedIdsChange)="settings.updateAutomationActionTemplates(automationId(), index(), $event)"
          />
        } @else {
          <p class="aaf-missing" i18n>{ settings.entityKind(), select, board {This board has no checklist templates yet.} other {This workspace has no checklist templates yet.} }</p>
        }
      </div>
    } @else if (a.type === 'move_to_list') {
      <label class="aaf-field">
        <span class="aaf-label" i18n="Field label">Destination list</span>
        <select [value]="settings.automationActionTargetValue(a)" (change)="settings.updateAutomationActionTarget(automationId(), index(), $any($event.target).value)">
          <option value="" [selected]="!settings.automationActionTargetValue(a)" i18n="Select placeholder">Choose list</option>
          @for (list of settings.lists(); track list.id) {
            <option [value]="list.id" [selected]="settings.automationActionTargetValue(a) === list.id">{{ list.name }}</option>
          }
        </select>
      </label>
      <label class="aaf-field aaf-narrow">
        <span class="aaf-label" i18n="Field label: position in the destination list (Top or Bottom)">Place at</span>
        <select [value]="settings.automationMovePlacementValue(a)" (change)="settings.updateAutomationMovePlacement(automationId(), index(), $any($event.target).value)">
          <option value="bottom" [selected]="settings.automationMovePlacementValue(a) === 'bottom'" i18n="Position in a list">Bottom</option>
          <option value="top" [selected]="settings.automationMovePlacementValue(a) === 'top'" i18n="Position in a list">Top</option>
        </select>
      </label>
    } @else if (a.type === 'set_due_date') {
      <label class="aaf-field aaf-narrow">
        <span class="aaf-label" i18n="Field label: when the due date is set to">Due</span>
        <select [value]="duePreset()" (change)="settings.updateAutomationDueDatePreset(automationId(), index(), $any($event.target).value)">
          @for (preset of settings.automationDueDatePresets; track preset.value) {
            <option [value]="preset.value" [selected]="duePreset() === preset.value">{{ preset.label }}</option>
          }
        </select>
      </label>
      @if (settings.isAutomationDueDateCustom(a, automationId(), index())) {
        <label class="aaf-field aaf-narrow">
          <span class="aaf-label" i18n="Field label: number of days after the automation runs">Days from trigger</span>
          <input
            type="number"
            [value]="settings.automationDueOffsetValue(a)"
            (input)="settings.updateAutomationDueOffset(automationId(), index(), +$any($event.target).value, true)"
            (blur)="settings.flushAutomationActionsSave(automationId())"
          />
        </label>
      }
      <label class="aaf-field aaf-narrow">
        <span class="aaf-label" i18n="Field label">Time of day</span>
        <select [value]="settings.automationDueSlotValue(a)" (change)="settings.updateAutomationDueSlot(automationId(), index(), $any($event.target).value)">
          @for (slot of settings.dueDateSlots; track slot) {
            <option [value]="slot" [selected]="settings.automationDueSlotValue(a) === slot">{{ settings.automationDueSlotLabel(slot) }}</option>
          }
        </select>
      </label>
    } @else if (a.type === 'set_completion') {
      <label class="aaf-field aaf-narrow">
        <span class="aaf-label" i18n="Field label; followed by Complete or Incomplete">Mark as</span>
        <select [value]="settings.automationCompletionValue(a)" (change)="settings.updateAutomationCompletion(automationId(), index(), $any($event.target).value === 'true')">
          <option value="true" [selected]="settings.automationCompletionValue(a) === 'true'" i18n="Card completion state">Complete</option>
          <option value="false" [selected]="settings.automationCompletionValue(a) === 'false'" i18n="Card completion state">Incomplete</option>
        </select>
      </label>
    } @else if (a.type === 'populate_custom_field') {
      <label class="aaf-field">
        <span class="aaf-label" i18n="Field label">Custom field</span>
        @if (settings.automationSetCustomFields().length) {
          <select [value]="settings.automationActionTargetValue(a)" (change)="settings.updateAutomationActionTarget(automationId(), index(), $any($event.target).value)">
            <option value="" [selected]="!settings.automationActionTargetValue(a)" i18n="Select placeholder: custom field">Choose field</option>
            @for (field of settings.automationSetCustomFields(); track field.id) {
              <option [value]="field.id" [selected]="settings.automationActionTargetValue(a) === field.id">{{ field.name }}</option>
            }
          </select>
        } @else {
          <p class="aaf-missing" i18n>{ settings.entityKind(), select, board {No fillable custom fields in this board yet.} other {No fillable custom fields in this workspace yet.} }</p>
        }
      </label>

      @if (settings.automationSetCustomField(a); as field) {
        <label class="aaf-field aaf-narrow">
          <span class="aaf-label" i18n="Field label; options: A fixed value / Another field">Value from</span>
          <select [value]="settings.automationPopulateMode(a)" (change)="settings.updateAutomationPopulateMode(automationId(), index(), $any($event.target).value)">
            <option value="value" [selected]="settings.automationPopulateMode(a) === 'value'" i18n>A fixed value</option>
            <option value="field" [selected]="settings.automationPopulateMode(a) === 'field'" i18n="Copy the value from another custom field">Another field</option>
          </select>
        </label>

        @if (settings.automationPopulateMode(a) === 'field') {
          <label class="aaf-field">
            <span class="aaf-label" i18n="Field label: source custom field">Copy from</span>
            @if (settings.automationPopulateSourceFields(a).length) {
              <select [value]="settings.automationPopulateSourceFieldId(a)" (change)="settings.updateAutomationPopulateSourceField(automationId(), index(), $any($event.target).value)">
                <option value="" [selected]="!settings.automationPopulateSourceFieldId(a)" i18n="Select placeholder: custom field">Choose field</option>
                @for (source of settings.automationPopulateSourceFields(a); track source.id) {
                  <option [value]="source.id" [selected]="settings.automationPopulateSourceFieldId(a) === source.id">{{ source.name }}</option>
                }
              </select>
            } @else {
              <p class="aaf-missing" i18n>{ field.type, select, text {No other text field to copy from.} number {No other number field to copy from.} date {No other date field to copy from.} checkbox {No other checkbox field to copy from.} select {No other select field to copy from.} user {No other user field to copy from.} url {No other url field to copy from.} other {No other field of this type to copy from.} }</p>
            }
          </label>
        } @else if (field.type === 'text') {
          <label class="aaf-field aaf-narrow">
            <span class="aaf-label" i18n="Field label: what to write into a text field (Fixed text / The run date)">Write</span>
            <select [value]="settings.automationPopulateTextSource(a)" (change)="settings.updateAutomationPopulateTextSource(automationId(), index(), $any($event.target).value)">
              <option value="text" [selected]="settings.automationPopulateTextSource(a) === 'text'" i18n>Fixed text</option>
              <option value="current_date" [selected]="settings.automationPopulateTextSource(a) === 'current_date'" i18n="The date the automation runs">The run date</option>
            </select>
          </label>
          @if (settings.automationPopulateTextSource(a) === 'text') {
            <label class="aaf-field">
              <span class="aaf-label" i18n="Field label: text value">Text</span>
              <input
                type="text"
                placeholder="Text to write" i18n-placeholder
                [value]="settings.automationPopulateTextValue(a)"
                (input)="settings.updateAutomationPopulateText(automationId(), index(), $any($event.target).value)"
                (blur)="settings.flushAutomationActionsSave(automationId())"
              />
            </label>
          } @else {
            <label class="aaf-field aaf-narrow">
              <span class="aaf-label" i18n="Field label: date format">Format</span>
              <select [value]="settings.automationPopulateTextDateFormat(a)" (change)="settings.updateAutomationPopulateTextDateFormat(automationId(), index(), $any($event.target).value)">
                @for (format of settings.automationTextDateFormats; track format) {
                  <option [value]="format" [selected]="settings.automationPopulateTextDateFormat(a) === format">{{ settings.automationPopulateTextDateFormatLabel(format) }}</option>
                }
              </select>
            </label>
          }
        } @else if (field.type === 'number') {
          <label class="aaf-field aaf-narrow">
            <span class="aaf-label" i18n="Field label: number value">Number</span>
            <input
              type="number"
              placeholder="0"
              [value]="settings.automationPopulateNumberValue(a)"
              (input)="settings.updateAutomationPopulateNumber(automationId(), index(), $any($event.target).value)"
              (blur)="settings.flushAutomationActionsSave(automationId())"
            />
          </label>
        } @else if (field.type === 'date') {
          <label class="aaf-field aaf-narrow">
            <span class="aaf-label" i18n="Field label: date value">Date</span>
            <select [value]="settings.automationPopulateDateSource(a)" (change)="settings.updateAutomationPopulateDateSource(automationId(), index(), $any($event.target).value)">
              <option value="current" [selected]="settings.automationPopulateDateSource(a) === 'current'" i18n="The date the automation runs">The run date</option>
              <option value="fixed" [selected]="settings.automationPopulateDateSource(a) === 'fixed'" i18n>A fixed date</option>
            </select>
          </label>
          @if (settings.automationPopulateDateSource(a) === 'fixed') {
            <label class="aaf-field aaf-narrow">
              <span class="aaf-label" i18n="Field label: the fixed date">On</span>
              <input
                type="date"
                [value]="settings.automationPopulateDateValue(a)"
                (input)="settings.updateAutomationPopulateDate(automationId(), index(), $any($event.target).value)"
                (blur)="settings.flushAutomationActionsSave(automationId())"
              />
            </label>
          }
        } @else if (field.type === 'checkbox') {
          <label class="aaf-field aaf-narrow">
            <span class="aaf-label" i18n="Field label: checkbox value (Checked / Unchecked)">Set to</span>
            <select [value]="settings.automationPopulateCheckboxValue(a)" (change)="settings.updateAutomationPopulateCheckbox(automationId(), index(), $any($event.target).value === 'true')">
              <option value="true" [selected]="settings.automationPopulateCheckboxValue(a) === 'true'" i18n="Checkbox custom field value">Checked</option>
              <option value="false" [selected]="settings.automationPopulateCheckboxValue(a) === 'false'" i18n="Checkbox custom field value">Unchecked</option>
            </select>
          </label>
        } @else if (field.type === 'select') {
          <div class="aaf-field">
            <span class="aaf-label">@if (field.allowMultiple) { <ng-container i18n="Field label: select custom field options">Options</ng-container> } @else { <ng-container i18n="Field label: select custom field option">Option</ng-container> }</span>
            <k-token-multi-select-dropdown
              icon="ti-list"
              [options]="fieldOptions()"
              [selectedIds]="settings.automationPopulateOptionIds(a)"
              [max]="field.allowMultiple ? null : 1"
              [placeholder]="field.allowMultiple ? chooseOptionsLabel : chooseOptionLabel"
              searchPlaceholder="Search options..."
              i18n-searchPlaceholder
              emptyMessage="This field has no options"
              i18n-emptyMessage
              ariaLabel="Custom field option"
              i18n-ariaLabel
              (selectedIdsChange)="settings.updateAutomationPopulateIds(automationId(), index(), 'select', $event)"
            />
          </div>
        } @else if (field.type === 'user') {
          <div class="aaf-field">
            <span class="aaf-label">@if (field.allowMultiple) { <ng-container i18n="Field label">Members</ng-container> } @else { <ng-container i18n="Field label">Member</ng-container> }</span>
            <k-user-multi-select-dropdown
              [users]="settings.automationMembers()"
              [selectedIds]="settings.automationPopulateUserIds(a)"
              [workspaceId]="settings.workspaceId()"
              [max]="field.allowMultiple ? null : 1"
              [allowEmpty]="true"
              [placeholder]="field.allowMultiple ? chooseMembersLabel : chooseMemberLabel"
              (selectedIdsChange)="settings.updateAutomationPopulateIds(automationId(), index(), 'user', $event)"
            />
          </div>
        }

        <div class="aaf-field aaf-wide">
          <span class="aaf-label" i18n>When the field already has a value</span>
          <div class="aaf-choice">
            <button type="button" class="aaf-choice-option" [class.is-active]="settings.automationPopulatePolicyValue(a) === 'empty'" (click)="settings.updateAutomationPopulatePolicy(automationId(), index(), 'empty')" [attr.aria-pressed]="settings.automationPopulatePolicyValue(a) === 'empty'">
              <i class="ti ti-shield-check"></i> <ng-container i18n="Option: keep the existing custom field value">Leave it alone</ng-container>
            </button>
            <button type="button" class="aaf-choice-option" [class.is-active]="settings.automationPopulatePolicyValue(a) === 'overwrite'" (click)="settings.updateAutomationPopulatePolicy(automationId(), index(), 'overwrite')" [attr.aria-pressed]="settings.automationPopulatePolicyValue(a) === 'overwrite'">
              <i class="ti ti-pencil"></i> <ng-container i18n="Option: replace the existing custom field value">Overwrite it</ng-container>
            </button>
          </div>
        </div>
      }
    } @else if (a.type === 'post_comment') {
      <label class="aaf-field aaf-wide">
        <span class="aaf-label" i18n="Field label: comment template">Comment</span>
        <textarea
          rows="3"
          placeholder="Markdown. Use the placeholders below for card details." i18n-placeholder
          [value]="settings.automationCommentTemplateValue(a)"
          (input)="settings.updateAutomationCommentTemplate(automationId(), index(), $any($event.target).value)"
          (blur)="settings.flushAutomationActionsSave(automationId())"
        ></textarea>
      </label>
      <div class="aaf-field aaf-wide aaf-variables" aria-label="Available placeholders" i18n-aria-label>
        @for (variable of settings.automationCommentTemplateVariables; track variable.token) {
          <code class="aaf-variable" [kTooltip]="variable.label">{{ variable.token }}</code>
        }
      </div>
    } @else if (a.type === 'call_webhook') {
      <label class="aaf-field">
        <span class="aaf-label" i18n="Field label">Webhook endpoint</span>
        @if (settings.webhooks().length) {
          <select [value]="settings.automationActionTargetValue(a)" (change)="settings.updateAutomationActionTarget(automationId(), index(), $any($event.target).value)">
            <option value="" [selected]="!settings.automationActionTargetValue(a)" i18n="Select placeholder: webhook endpoint">Choose endpoint</option>
            @for (hook of settings.webhooks(); track hook.id) {
              <option [value]="hook.id" [selected]="settings.automationActionTargetValue(a) === hook.id">@if (hook.enabled) { {{ hook.name }} } @else { <ng-container i18n="Webhook endpoint that is turned off">{{ hook.name // i18n(ph="endpoint") }} (disabled)</ng-container> }</option>
            }
          </select>
        } @else {
          <p class="aaf-missing" i18n>No webhook endpoints yet. Add one under the API tab first.</p>
        }
      </label>
    } @else {
      <!-- clear_due_date, move_to_top, move_to_bottom: no configuration. Say so rather than
           rendering the old literal "No target" placeholder in the middle of the row. -->
      <p class="aaf-no-config"><i class="ti ti-check"></i> <ng-container i18n>Runs as-is — nothing to configure.</ng-container></p>
    }
  `,
  styleUrl: "./automation-action-fields.component.scss",
})
export class AutomationActionFieldsComponent {
  protected readonly settings = inject(WorkspaceSettingsPage);

  readonly automationId = input.required<string>();
  readonly index = input.required<number>();
  readonly action = input.required<AutomationActionBody>();

  protected readonly labelOptions = computed(() =>
    this.settings.labels().map((label) => ({
      id: label.id,
      name: label.name,
      // The picker resolves the token itself, the same way every other coloured row in the app does.
      color: label.color ?? null,
    })),
  );

  protected readonly fieldOptions = computed(() => {
    const field = this.settings.automationSetCustomField(this.action());
    if (!field || field.type !== "select") return [];
    return field.options.map((option) => ({ id: option.id, name: option.label, color: null }));
  });

  protected readonly chooseOptionsLabel = $localize`Choose options`;
  protected readonly chooseOptionLabel = $localize`Choose an option`;
  protected readonly chooseMembersLabel = $localize`Choose members`;
  protected readonly chooseMemberLabel = $localize`Choose a member`;

  protected readonly duePreset = computed(() =>
    this.settings.automationDueDatePresetValue(this.action(), this.automationId(), this.index()),
  );
}
