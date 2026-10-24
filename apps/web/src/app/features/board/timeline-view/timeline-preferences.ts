import { computed, signal, type Signal } from "@angular/core";
import { viewPreferenceKey } from "../../../core/browser/browser-contracts";
import type { SegmentedOption } from "../../../shared/segmented.component";
import { clampPxPerDay, DEFAULT_PX_PER_DAY, type TimelineGroupByKind } from "./timeline-layout";

/**
 * What the Timeline remembers per board, in this browser: how far it is zoomed (pixels per day), how
 * rows are grouped, which groups are folded, whether the critical path and dependency wires are shown
 * and how wide the name pane was dragged (null keeps the automatic width). Display choices, so they
 * live with the device like the other view preferences and never on the account.
 */
export interface TimelinePreference {
  pxPerDay: number;
  groupBy: TimelineGroupByKind;
  critical: boolean;
  dependencies: boolean;
  collapsed: string[];
  nameWidth: number | null;
}

const GROUP_BYS: readonly TimelineGroupByKind[] = ["list", "assignee", "label", "none"];

const DEFAULT_TIMELINE_PREFERENCE: TimelinePreference = {
  pxPerDay: DEFAULT_PX_PER_DAY,
  groupBy: "list",
  critical: false,
  dependencies: true,
  collapsed: [],
  nameWidth: null,
};

export function readTimelinePreference(scope: string): TimelinePreference {
  try {
    const raw = localStorage.getItem(viewPreferenceKey("timeline", scope));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_TIMELINE_PREFERENCE;
    const value = parsed as Record<string, unknown>;
    return {
      pxPerDay: readPxPerDay(value),
      groupBy: GROUP_BYS.includes(value["groupBy"] as TimelineGroupByKind) ? (value["groupBy"] as TimelineGroupByKind) : DEFAULT_TIMELINE_PREFERENCE.groupBy,
      critical: value["critical"] === true,
      dependencies: value["dependencies"] !== false,
      collapsed: Array.isArray(value["collapsed"]) ? value["collapsed"].filter((key): key is string => typeof key === "string") : [],
      nameWidth: typeof value["nameWidth"] === "number" && Number.isFinite(value["nameWidth"]) ? value["nameWidth"] : null,
    };
  } catch {
    return DEFAULT_TIMELINE_PREFERENCE;
  }
}

// Before the zoom was continuous it was stored as one of three named steps; those map onto the
// scale so a remembered zoom survives.
const NAMED_ZOOM_PX: Record<string, number> = { day: 40, week: 16, month: 6 };

function readPxPerDay(value: Record<string, unknown>): number {
  const px = value["pxPerDay"];
  if (typeof px === "number" && Number.isFinite(px)) return clampPxPerDay(px);
  const named = typeof value["zoom"] === "string" ? NAMED_ZOOM_PX[value["zoom"]] : undefined;
  return named ?? DEFAULT_PX_PER_DAY;
}

export function writeTimelinePreference(scope: string, value: TimelinePreference): void {
  try {
    localStorage.setItem(viewPreferenceKey("timeline", scope), JSON.stringify(value));
  } catch {
    // Storage can be unavailable in privacy mode or over quota; the in-memory choice still applies.
  }
}

export interface TimelineGroupByState {
  groupBy: Signal<TimelineGroupByKind>;
  options: readonly SegmentedOption<TimelineGroupByKind>[];
  setGroupBy(groupBy: TimelineGroupByKind): void;
}

/**
 * The list/assignee/label/none grouping, owned by the host page so its switch sits in the query bar
 * ahead of Filter, where the Dependencies view keeps its layout switch. It shares the Timeline's
 * stored preference with the toggles the view owns itself, so each write merges into that record
 * rather than replacing it.
 */
export function timelineGroupByState(scope: () => string): TimelineGroupByState {
  const chosen = signal<{ scope: string; groupBy: TimelineGroupByKind } | null>(null);
  return {
    groupBy: computed(() => {
      const current = scope();
      const picked = chosen();
      return picked?.scope === current ? picked.groupBy : readTimelinePreference(current).groupBy;
    }),
    options: [
      { id: "list", icon: "list-details", label: $localize`:Timeline view grouping - one group per list:By list` },
      { id: "assignee", icon: "users", label: $localize`:Timeline view grouping - one group per assignee:By assignee` },
      { id: "label", icon: "tag", label: $localize`:Timeline view grouping - one group per label:By label` },
      { id: "none", icon: "list", label: $localize`:Timeline view grouping - a flat list of cards:No groups` },
    ],
    setGroupBy(groupBy) {
      const current = scope();
      chosen.set({ scope: current, groupBy });
      writeTimelinePreference(current, { ...readTimelinePreference(current), groupBy });
    },
  };
}
