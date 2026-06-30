// Storage is an org-level pool (hosted mode). When it is full the fix differs by role: an org admin
// can upgrade the plan, while a member must ask an admin. Centralised here so the three attachment
// uploaders (card detail, description editor, note editor) show identical, role-correct guidance.
export function storageFullMessage(isOrgAdmin: boolean): string {
  return isOrgAdmin
    ? "Your organisation's storage is full. Upgrade your plan to upload more files."
    : "Your organisation's storage is full. Ask an organisation admin to upgrade for more storage.";
}

export function fileTooLargeMessage(maxLabel: string, isOrgAdmin: boolean, isPlanLimited: boolean): string {
  const base = `File is too large (max ${maxLabel})`;
  if (!isPlanLimited) return base;
  return isOrgAdmin
    ? `${base}. Upgrade your plan for higher file limits.`
    : `${base}. Ask an organisation admin to upgrade for higher file limits.`;
}
