import { DEFAULT_WORKSPACE_TEMPLATE } from "./workspace-templates.js";

export type DefaultWorkspaceCustomField = {
  name: string;
  icon: string;
  type: "text" | "number" | "checkbox";
};

export const DEFAULT_WORKSPACE_CUSTOM_FIELDS: DefaultWorkspaceCustomField[] =
  DEFAULT_WORKSPACE_TEMPLATE.customFields.map((field) => ({
    name: field.name,
    icon: field.icon,
    type: field.type as DefaultWorkspaceCustomField["type"],
  }));
