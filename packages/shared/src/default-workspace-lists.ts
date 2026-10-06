import { DEFAULT_WORKSPACE_TEMPLATE } from "./workspace-templates.js";

export const DEFAULT_WORKSPACE_LIST_NAMES = DEFAULT_WORKSPACE_TEMPLATE.lists.map((list) => list.name);
/** The default workflow with its in-progress flags, for workspaces created without explicit lists. */
export const DEFAULT_WORKSPACE_LISTS = DEFAULT_WORKSPACE_TEMPLATE.lists;
