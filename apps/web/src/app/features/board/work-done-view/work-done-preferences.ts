import { computed, signal, type Signal } from "@angular/core";
import type { SegmentedOption } from "../../../shared/segmented.component";
import type { WorkDoneLayout, WorkDoneRangePreset } from "./work-done.types";

export type WorkDonePreferenceScope = "board" | "global";

const STORAGE_KEY = "kanera.workDone.prefs";

export interface WorkDonePreferences {
  /** Period preset for the list layout. */
  preset?: WorkDoneRangePreset;
  /**
   * Period preset for the report layout, kept apart from `preset`: a timeline is usually read over
   * the last few days while a report is read over the working week, so switching layouts switches
   * periods rather than making the reader re-pick one each time.
   */
  reportPreset?: WorkDoneRangePreset;
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

function readWorkDoneLayout(scope: WorkDonePreferenceScope): WorkDoneLayout {
  const layout = readWorkDonePreferences(scope).layout;
  // A "grid" remembered from before that layout was retired falls back to the list.
  return layout === "report" ? "report" : "list";
}

function writeWorkDoneLayout(scope: WorkDonePreferenceScope, layout: WorkDoneLayout): void {
  updateWorkDonePreferences(scope, { layout });
}

export interface WorkDoneLayoutState {
  /** The layout to render: the stored preference. */
  layout: Signal<WorkDoneLayout>;
  options: Signal<readonly SegmentedOption<WorkDoneLayout>[]>;
  setLayout(layout: WorkDoneLayout): void;
}

/** The list/report choice for a Work Done surface; both layouts reflow for phones. */
export function workDoneLayoutState(scope: WorkDonePreferenceScope): WorkDoneLayoutState {
  const preferred = signal<WorkDoneLayout>(readWorkDoneLayout(scope));
  return {
    layout: preferred,
    options: computed(() => [
      // Labelled (hosts render with showLabels): icons alone read as decoration, and Report in
      // particular was invisible to the people it is for. The long form is the accessible tooltip.
      { id: "list", icon: "list-details", label: $localize`:Short work done layout label:List`, tooltip: $localize`:Work done layout option - one column:List layout` },
      { id: "report", icon: "report-analytics", label: $localize`:Short work done layout label:Report`, tooltip: $localize`:Work done layout option - management summary with charts:Report layout` },
    ]),
    setLayout(layout) {
      preferred.set(layout);
      writeWorkDoneLayout(scope, layout);
    },
  };
}
