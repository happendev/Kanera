export function localDateParts(date: Date, timezone: string): { date: string; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const byType = new Map(parts.map((part) => [part.type, part.value]));
    return {
      date: `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`,
      hour: Number(byType.get("hour") ?? "0"),
    };
  } catch {
    return { date: date.toISOString().slice(0, 10), hour: date.getUTCHours() };
  }
}
