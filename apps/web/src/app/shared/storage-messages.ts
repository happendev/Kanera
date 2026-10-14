// Storage is an org-level pool (hosted mode). When it is full the fix differs by role: an org admin
// can upgrade the plan, while a member must ask an admin. Centralised here so the three attachment
// uploaders (card detail, description editor, note editor) show identical, role-correct guidance.
export function storageFullMessage(isOrgAdmin: boolean): string {
  return isOrgAdmin
    ? $localize`:Upload error shown to an organisation admin:Your organisation's storage is full. Upgrade your plan to upload more files.`
    : $localize`:Upload error shown to an organisation member:Your organisation's storage is full. Ask an organisation admin to upgrade for more storage.`;
}

export function fileTooLargeMessage(maxLabel: string, isOrgAdmin: boolean, isPlanLimited: boolean): string {
  // Whole sentences per case, so each language can place the size limit where it reads naturally.
  if (!isPlanLimited) return $localize`:Upload error; the placeholder is a size such as "5 MB":File is too large (max ${maxLabel}:maxSize:)`;
  return isOrgAdmin
    ? $localize`:Upload error shown to an organisation admin; the placeholder is a size such as "5 MB":File is too large (max ${maxLabel}:maxSize:). Upgrade your plan for higher file limits.`
    : $localize`:Upload error shown to an organisation member; the placeholder is a size such as "5 MB":File is too large (max ${maxLabel}:maxSize:). Ask an organisation admin to upgrade for higher file limits.`;
}
