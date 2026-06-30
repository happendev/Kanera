export interface ImportSourceMemberIdentity {
  fullName: string;
  username?: string | null;
  email?: string | null;
}

export interface ImportTargetMemberIdentity {
  userId: string;
  displayName: string;
  email: string;
}

export function normalizedIdentity(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/gu, "");
}

function emailLocalPart(value: string | null | undefined): string {
  return normalizedIdentity(value).split("@", 1)[0] ?? "";
}

export function findMatchingImportMember<T extends ImportTargetMemberIdentity>(
  source: ImportSourceMemberIdentity,
  targets: T[],
): T | undefined {
  const sourceName = normalizedIdentity(source.fullName);
  const sourceEmail = normalizedIdentity(source.email);
  const sourceUsername = normalizedIdentity(source.username);
  const sourceUsernameLocalPart = emailLocalPart(source.username);

  return targets.find((target) => {
    const displayName = normalizedIdentity(target.displayName);
    const email = normalizedIdentity(target.email);
    const localPart = emailLocalPart(target.email);
    // Kanera exports carry email for deterministic identity matching. Trello exports often
    // expose only username, which may be either an email address or the email local part.
    return (sourceName && displayName === sourceName) ||
      (sourceEmail && email === sourceEmail) ||
      (sourceUsername && (email === sourceUsername || localPart === sourceUsername || localPart === sourceUsernameLocalPart));
  });
}
