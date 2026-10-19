import { computed, signal, type Signal } from "@angular/core";
import { viewPreferenceKey } from "../../core/browser/browser-contracts";
import type { SegmentedOption } from "../../shared/segmented.component";

export type DependencyLayout = "map" | "timeline" | "list";

const LAYOUTS: readonly DependencyLayout[] = ["map", "timeline", "list"];
/** The narrowest viewport that opens on the map by default; below it the step list reads better. */
const MAP_MIN_VIEWPORT = 720;

/** The map's whole stored preference; the layout shares it with the toggles the map owns itself. */
export function readDependencyPreference(scope: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(viewPreferenceKey("dependencyMap", scope));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Merges rather than replaces: the host's toolbar writes the layout and the map writes its toggles,
 * so neither may drop the other's choice.
 */
export function updateDependencyPreference(scope: string, patch: Record<string, unknown>): void {
  try {
    localStorage.setItem(viewPreferenceKey("dependencyMap", scope), JSON.stringify({ ...readDependencyPreference(scope), ...patch }));
  } catch {
    // Storage can be unavailable in privacy mode or over quota; the in-memory choice still applies.
  }
}

export interface DependencyLayoutState {
  layout: Signal<DependencyLayout>;
  options: readonly SegmentedOption<DependencyLayout>[];
  setLayout(layout: DependencyLayout): void;
}

/**
 * The Map/Timeline/Steps choice, owned by the host page so the switch sits in its toolbar beside
 * the other view controls, as Work done's layout switch does. Remembered per preference scope.
 */
export function dependencyLayoutState(scope: () => string): DependencyLayoutState {
  const chosen = signal<{ scope: string; layout: DependencyLayout } | null>(null);
  return {
    layout: computed(() => {
      const current = scope();
      const picked = chosen();
      if (picked?.scope === current) return picked.layout;
      const stored = readDependencyPreference(current)["layout"];
      if (LAYOUTS.includes(stored as DependencyLayout)) return stored as DependencyLayout;
      // Only a layout the viewer picked is remembered; otherwise each device keeps its own default.
      return viewportWidth() < MAP_MIN_VIEWPORT ? "list" : "map";
    }),
    options: [
      { id: "map", icon: "git-merge", label: $localize`:dependency map layout|Dependencies view layout - chains drawn as a map with connectors:Map` },
      { id: "timeline", icon: "calendar-week", label: $localize`:Dependencies view layout - cards placed in columns by the week they are due:Timeline` },
      { id: "list", icon: "list-numbers", label: $localize`:Dependencies view layout - chains listed step by step:Steps` },
    ],
    setLayout(layout) {
      const current = scope();
      chosen.set({ scope: current, layout });
      updateDependencyPreference(current, { layout });
    },
  };
}

function viewportWidth(): number {
  return typeof window === "undefined" ? 1280 : window.visualViewport?.width ?? window.innerWidth;
}
