import type { ColorToken } from "@kanera/shared/colors";
import type { WorkspaceTemplate } from "@kanera/shared/workspace-templates";

// Standalone creation is available from both first-run onboarding and the in-app dialog. Keep the
// request in one place so both entry points always seed the exact same onboarding template.
export function standaloneBoardCreatePayload(
  name: string,
  template: WorkspaceTemplate,
  identity: { icon?: string; iconColor?: ColorToken | null } = {},
) {
  const icon = identity.icon ?? template.icon;
  return {
    kind: "board" as const,
    name,
    icon,
    initialBoard: {
      name,
      icon,
      ...(identity.iconColor !== undefined ? { iconColor: identity.iconColor } : {}),
    },
    lists: template.lists,
    customFields: template.customFields,
    labels: template.labels,
  };
}
