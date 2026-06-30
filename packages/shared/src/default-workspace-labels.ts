import type { ColorToken } from "./lib/colors.js";
import { DEFAULT_WORKSPACE_TEMPLATE } from "./workspace-templates.js";

export type DefaultWorkspaceLabel = {
  name: string;
  color: ColorToken;
};

export const DEFAULT_WORKSPACE_LABELS: DefaultWorkspaceLabel[] =
  DEFAULT_WORKSPACE_TEMPLATE.labels.map((label) => ({ ...label }));
