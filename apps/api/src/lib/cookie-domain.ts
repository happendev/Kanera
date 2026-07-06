export function cookieDomainAttribute(domain: string): string | undefined {
  const normalized = domain.trim().toLowerCase();
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost")) return undefined;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return undefined;
  if (normalized.startsWith("[") && normalized.endsWith("]")) return undefined;
  return domain;
}
