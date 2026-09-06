/** Reuse ICU formatters across rows and requests, never the date-dependent formatted output. */
export function dateTimeFormatter(options: Intl.DateTimeFormatOptions) {
  const formatters = new Map<string, Intl.DateTimeFormat>();
  return (timeZone: string): Intl.DateTimeFormat => {
    const existing = formatters.get(timeZone);
    if (existing) return existing;
    const formatter = new Intl.DateTimeFormat("en-CA", { ...options, timeZone });
    // Zones may come from imports or profiles. Bound retained ICU objects even when inputs vary;
    // failed construction is not cached so callers retain their existing fallback behavior.
    if (formatters.size >= 128) formatters.delete(formatters.keys().next().value!);
    formatters.set(timeZone, formatter);
    return formatter;
  };
}
