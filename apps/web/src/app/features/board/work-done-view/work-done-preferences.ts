import type { WorkDoneLayout, WorkDoneRangePreset } from "./work-done.types";

export type WorkDonePreferenceScope = "board" | "global";

const STORAGE_KEY = "kanera.workDone.prefs";

export interface WorkDonePreferences {
  preset?: WorkDoneRangePreset;
  layout?: WorkDoneLayout;
}

export function workDonePreferencesStorageKey(scope: WorkDonePreferenceScope): string {
  return `${STORAGE_KEY}.${scope}`;
}

export function readWorkDonePreferences(scope: WorkDonePreferenceScope): WorkDonePreferences {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(workDonePreferencesStorageKey(scope));
    return raw ? (JSON.parse(raw) as WorkDonePreferences) : {};
  } catch {
    return {};
  }
}

export function updateWorkDonePreferences(
  scope: WorkDonePreferenceScope,
  patch: Partial<WorkDonePreferences>,
): void {
  if (typeof localStorage === "undefined") return;
  try {
    // Range and layout are changed by different components. Merge each update so changing one does
    // not silently reset the other preference when the reader returns to Work Done.
    localStorage.setItem(
      workDonePreferencesStorageKey(scope),
      JSON.stringify({ ...readWorkDonePreferences(scope), ...patch }),
    );
  } catch {
    // The in-memory controls still work when storage is unavailable in a hardened browser context.
  }
}

export function readWorkDoneLayout(scope: WorkDonePreferenceScope): WorkDoneLayout {
  return readWorkDonePreferences(scope).layout === "grid" ? "grid" : "list";
}

export function writeWorkDoneLayout(scope: WorkDonePreferenceScope, layout: WorkDoneLayout): void {
  updateWorkDonePreferences(scope, { layout });
}
