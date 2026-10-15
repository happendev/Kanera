import type { AutomationActionBody } from "@kanera/shared/dto";
import type { AutomationAction } from "@kanera/shared/schema";

type PopulateAction = Extract<AutomationActionBody, { type: "populate_custom_field" }>;
type ExecutableActionBody = Exclude<AutomationActionBody, PopulateAction> | {
  type: "populate_custom_field";
  config: Omit<PopulateAction["config"], "value"> & { value: PopulateAction["config"]["value"] | null };
};

export type ExecutableAutomationAction<Type extends AutomationActionBody["type"] = AutomationActionBody["type"]> =
  Omit<AutomationAction, "type" | "config"> & Extract<ExecutableActionBody, { type: Type }>;

// Stored actions are not creation requests. Preserve the executor's historical defaults here;
// the editor deliberately has different coercions for unfinished drafts and old singular IDs.
export function executableAutomationAction(action: AutomationAction): ExecutableAutomationAction | null {
  const config = action.config;
  switch (action.type) {
    case "add_labels":
    case "remove_labels":
      return { ...action, type: action.type, config: { labelIds: "labelIds" in config ? config.labelIds : [] } };
    case "add_assignees":
    case "remove_assignees":
      return { ...action, type: action.type, config: { userIds: "userIds" in config ? config.userIds : [] } };
    case "apply_checklists":
      return { ...action, type: action.type, config: { templateIds: "templateIds" in config ? config.templateIds : [] } };
    case "set_due_date":
      return {
        ...action,
        type: action.type,
        config: {
          offsetDays: "offsetDays" in config ? config.offsetDays : 0,
          slot: "slot" in config ? config.slot : "anyTime",
        },
      };
    case "set_completion":
      return { ...action, type: action.type, config: { completed: "completed" in config ? config.completed : false } };
    case "move_to_list":
      return {
        ...action,
        type: action.type,
        config: {
          listId: "listId" in config ? config.listId : "",
          placement: "placement" in config && config.placement === "top" ? "top" : "bottom",
        },
      };
    case "populate_custom_field":
      if (!("fieldId" in config) || !config.fieldId) return null;
      return {
        ...action,
        type: action.type,
        config: {
          fieldId: config.fieldId,
          value: "value" in config ? config.value : null,
          onlyIfEmpty: "onlyIfEmpty" in config ? config.onlyIfEmpty : true,
        },
      };
    case "post_comment":
      return { ...action, type: action.type, config: { template: "template" in config && typeof config.template === "string" ? config.template : "" } };
    case "call_webhook":
      return { ...action, type: action.type, config: { endpointId: "endpointId" in config && typeof config.endpointId === "string" ? config.endpointId : "" } };
    case "clear_due_date":
    case "move_to_top":
    case "move_to_bottom":
      return { ...action, type: action.type, config: {} };
  }
}
