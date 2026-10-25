import { computed, signal, type Signal } from "@angular/core";
import { viewPreferenceKey } from "../../../core/browser/browser-contracts";
import type { SegmentedOption } from "../../../shared/segmented.component";
import { clampPxPerDay, type TimelineGroupByKind } from "./timeline-layout";

/**
 * What the Timeline remembers per board, in this browser: how far it is zoomed (pixels per day, or
 * null until the viewer picks a zoom, which opens the chart fitted to the plan), how rows are
 * grouped, which groups are folded, whether the critical path and dependency wires are shown and how
 * wide the name pane was dragged (null keeps the automatic width). Display choices, so they live
 * with the device like the other view preferences and never on the account.
 */
export interface TimelinePreference {
  pxPerDay: number | null;
  groupBy: TimelineGroupByKind;
  critical: boolean;
  dependencies: boolean;
  collapsed: string[];
  nameWidth: number | null;
}

const GROUP_BYS: readonly TimelineGroupByKind[] = ["board", "list", "assignee", "label", "none"];

const DEFAULT_TIMELINE_PREFERENCE: TimelinePreference = {
  pxPerDay: null,
  groupBy: "list",
  critical: false,
  dependencies: true,
  collapsed: [],
  nameWidth: null,
};

/**
 * How the Timeline opens before the viewer picks a grouping: a board's chart follows its lists; a
 * chart over many boards (My Cards, Team Cards) groups by board, since the lists of several
 * workspaces share names and would interleave work from unrelated boards under one heading.
 */
export type TimelineGroupingScope = "board" | "multiBoard";

function defaultGroupBy(scope: TimelineGroupingScope): TimelineGroupByKind {
  return scope === "multiBoard" ? "board" : "list";
}

export function readTimelinePreference(scope: string, grouping: TimelineGroupingScope = "board"): TimelinePreference {
  const fallback = { ...DEFAULT_TIMELINE_PREFERENCE, groupBy: defaultGroupBy(grouping) };
  try {
    const raw = localStorage.getItem(viewPreferenceKey("timeline", scope));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return fallback;
    const value = parsed as Record<string, unknown>;
    // "By board" is meaningless on one board, so a value carried over from elsewhere falls back.
    const storedGroupBy = value["groupBy"] as TimelineGroupByKind;
    const groupByAllowed = GROUP_BYS.includes(storedGroupBy) && (storedGroupBy !== "board" || grouping === "multiBoard");
    return {
      pxPerDay: readPxPerDay(value),
      groupBy: groupByAllowed ? storedGroupBy : fallback.groupBy,
      critical: value["critical"] === true,
      dependencies: value["dependencies"] !== false,
      collapsed: Array.isArray(value["collapsed"]) ? value["collapsed"].filter((key): key is string => typeof key === "string") : [],
      nameWidth: typeof value["nameWidth"] === "number" && Number.isFinite(value["nameWidth"]) ? value["nameWidth"] : null,
    };
  } catch {
    return fallback;
  }
}

// Before the zoom was continuous it was stored as one of three named steps, and "week" was written
// whether or not anyone picked it; the other two were a choice, so they map onto the scale.
const NAMED_ZOOM_PX: Record<string, number> = { day: 40, month: 6 };

function readPxPerDay(value: Record<string, unknown>): number | null {
  const px = value["pxPerDay"];
  if (typeof px === "number" && Number.isFinite(px)) return clampPxPerDay(px);
  const named = typeof value["zoom"] === "string" ? NAMED_ZOOM_PX[value["zoom"]] : undefined;
  return named ?? null;
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
export function timelineGroupByState(scope: () => string, grouping: TimelineGroupingScope = "board"): TimelineGroupByState {
  const chosen = signal<{ scope: string; groupBy: TimelineGroupByKind } | null>(null);
  return {
    groupBy: computed(() => {
      const current = scope();
      const picked = chosen();
      return picked?.scope === current ? picked.groupBy : readTimelinePreference(current, grouping).groupBy;
    }),
    options: [
      ...(grouping === "multiBoard"
        ? [{ id: "board" as const, icon: "layout-kanban", label: $localize`:Timeline view grouping - one group per board:By board` }]
        : []),
      { id: "list", icon: "list-details", label: $localize`:Timeline view grouping - one group per list:By list` },
      { id: "assignee", icon: "users", label: $localize`:Timeline view grouping - one group per assignee:By assignee` },
      { id: "label", icon: "tag", label: $localize`:Timeline view grouping - one group per label:By label` },
      { id: "none", icon: "list", label: $localize`:Timeline view grouping - a flat list of cards:No groups` },
    ],
    setGroupBy(groupBy) {
      const current = scope();
      chosen.set({ scope: current, groupBy });
      writeTimelinePreference(current, { ...readTimelinePreference(current, grouping), groupBy });
    },
  };
}
