import { timeZoneOffsetMinutes } from "../../../shared/date-format";
import type { PickerGroup } from "../../../shared/picker-list.component";

let zoneList: string[] | null = null;

/** Every IANA zone the browser knows, with UTC first-class even where the runtime omits it. */
function supportedTimeZones(): string[] {
  if (!zoneList) {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
    const zones = intl.supportedValuesOf?.("timeZone") ?? [];
    zoneList = zones.includes("UTC") ? zones : ["UTC", ...zones];
  }
  return zoneList;
}

/**
 * Chromium and Node list CLDR's frozen names for zones IANA has since renamed, so a person searching
 * "Kolkata" or "Kyiv" would find nothing. These display under the current name; the stored id stays
 * the one the runtime gave, which both the browser and the server accept.
 */
const CURRENT_ZONE_NAMES: Record<string, string> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Coral_Harbour": "America/Atikokan",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

/**
 * "UTC+05:30", "UTC-03:00", "UTC+00:00". An ASCII hyphen rather than a typographic minus, so typing
 * "-03" in the picker's search finds it.
 */
export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

/**
 * The working-hours zone picker's options: west to east by current offset, then by name, each labelled
 * "(UTC+05:30) Asia/Kolkata" so the offset reads in the closed trigger too and the label alone is
 * what search matches (a city, a region or an offset). Underscores in IANA names become spaces, so
 * "new york" finds America/New_York, and renamed zones show their current name. The saved zone is
 * always included, even one this browser lacks.
 */
export function timeZonePickerGroups(current: string, at = new Date()): PickerGroup[] {
  const known = supportedTimeZones();
  // A saved current name this runtime lists under its old one (Kolkata saved from Firefox, viewed in
  // Chromium) replaces that entry rather than appearing twice under the same label.
  const zones = known.includes(current)
    ? known
    : [current, ...known.filter((zone) => CURRENT_ZONE_NAMES[zone] !== current)];
  const options = zones
    // Offsets follow daylight saving, so the order describes today; an unknown zone reads as UTC,
    // matching the server's fallback for working hours.
    .map((zone) => ({ zone, offset: timeZoneOffsetMinutes(zone, at) ?? 0, name: (CURRENT_ZONE_NAMES[zone] ?? zone).replaceAll("_", " ") }))
    .sort((a, b) => a.offset - b.offset || a.name.localeCompare(b.name))
    .map(({ zone, offset, name }) => ({ id: zone, label: `(${formatUtcOffset(offset)}) ${name}` }));
  return [{ id: "time-zones", options }];
}
