/**
 * Optional planning features a team can switch off when it does not need them. Each is a column on
 * both the organisation (the master switch) and the workspace, and is effective only when both are
 * on: a workspace can opt out, but cannot override an organisation that turned a feature off.
 * Turning one off hides it and closes its API, MCP and CLI surfaces but keeps the data, so turning it
 * back on restores everything as it was.
 *
 * - `dependencies`: `blocks` card relations, blocked state and the card_blocked / card_unblocked
 *   automation triggers. `relates_to` relations are plain links, not dependencies, and stay on.
 * - `timeline`: start dates, the Timeline view and the schedule engine (conflicts, critical path,
 *   schedule health) with its scheduling automation triggers.
 * - `inProgress`: time in progress tracking. Boards keep their own opt-out beneath this one.
 */
export const WORKSPACE_FEATURES = ["dependencies", "timeline", "inProgress"] as const;
export type WorkspaceFeature = (typeof WORKSPACE_FEATURES)[number];

export type WorkspaceFeatures = Record<WorkspaceFeature, boolean>;

export const ALL_WORKSPACE_FEATURES_ENABLED: Readonly<WorkspaceFeatures> = Object.freeze({
  dependencies: true,
  timeline: true,
  inProgress: true,
});

interface FeatureSwitches {
  dependenciesEnabled: boolean;
  timelineEnabled: boolean;
  inProgressEnabled: boolean;
}

/** The effective features of a workspace: on only where its organisation and the workspace agree. */
export function effectiveWorkspaceFeatures(organisation: FeatureSwitches, workspace: FeatureSwitches): WorkspaceFeatures {
  return {
    dependencies: organisation.dependenciesEnabled && workspace.dependenciesEnabled,
    timeline: organisation.timelineEnabled && workspace.timelineEnabled,
    inProgress: organisation.inProgressEnabled && workspace.inProgressEnabled,
  };
}

/**
 * Automation triggers that only make sense while a feature is on. Scheduling conflicts and
 * critical paths need both: without dependencies nothing chains, so nothing can conflict.
 */
const TRIGGER_FEATURES: Partial<Record<string, readonly WorkspaceFeature[]>> = {
  card_blocked: ["dependencies"],
  card_unblocked: ["dependencies"],
  start_date_arrives: ["timeline"],
  scheduling_conflict_appears: ["timeline", "dependencies"],
  critical_path_slips: ["timeline", "dependencies"],
  card_in_progress_too_long: ["inProgress"],
};

/** The first feature this trigger needs that is switched off, or null when it can run. */
export function automationTriggerBlockedBy(triggerType: string, features: WorkspaceFeatures): WorkspaceFeature | null {
  return TRIGGER_FEATURES[triggerType]?.find((feature) => !features[feature]) ?? null;
}
