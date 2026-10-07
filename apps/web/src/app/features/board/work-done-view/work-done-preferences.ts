import { computed, signal, type Signal } from "@angular/core";
import type { SegmentedOption } from "../../../shared/segmented.component";
import { mediaQuerySignal } from "../../../shared/media-query.signal";
import { NARROW_WORK_DONE_LAYOUT_QUERY, type WorkDoneLayout, type WorkDoneRangePreset } from "./work-done.types";

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

function readWorkDoneLayout(scope: WorkDonePreferenceScope): WorkDoneLayout {
  return readWorkDonePreferences(scope).layout === "grid" ? "grid" : "list";
}

function writeWorkDoneLayout(scope: WorkDonePreferenceScope, layout: WorkDoneLayout): void {
  updateWorkDonePreferences(scope, { layout });
}

export interface WorkDoneLayoutState {
  /** The layout to render: the stored preference, or List while the grid cannot form columns. */
  layout: Signal<WorkDoneLayout>;
  options: Signal<readonly SegmentedOption<WorkDoneLayout>[]>;
  setLayout(layout: WorkDoneLayout): void;
}

/**
 * The list/grid choice for a Work Done surface. Grid is a wide-screen preference, so below the
 * narrow breakpoint the stored choice is kept but List is rendered and the Grid option is disabled.
 * Must be created in an injection context (it watches a media query).
 */
export function workDoneLayoutState(scope: WorkDonePreferenceScope): WorkDoneLayoutState {
  const preferred = signal<WorkDoneLayout>(readWorkDoneLayout(scope));
  const narrow = mediaQuerySignal(NARROW_WORK_DONE_LAYOUT_QUERY);
  return {
    layout: computed(() => (narrow() ? "list" : preferred())),
    options: computed(() => [
      { id: "list", icon: "list-details", label: "List layout" },
      { id: "grid", icon: "layout-grid", label: "Grid layout", disabled: narrow() },
    ]),
    setLayout(layout) {
      if (layout === "grid" && narrow()) return;
      preferred.set(layout);
      writeWorkDoneLayout(scope, layout);
    },
  };
}
