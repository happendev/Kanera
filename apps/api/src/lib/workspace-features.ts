import { effectiveWorkspaceFeatures, type WorkspaceFeature, type WorkspaceFeatures } from "@kanera/shared/workspace-features";
import { boards, clients, workspaces } from "@kanera/shared/schema";
import { eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { db, type Tx } from "../db.js";
import { emitToBoardAudience } from "../realtime/emit.js";
import { AppError, notFound } from "./errors.js";

/**
 * Optional planning features are switched on the organisation and the workspace together (see
 * `@kanera/shared/workspace-features`). Every surface that creates, computes or reports one of them
 * asks this module, so the app API, public API, MCP and CLI agree on what a workspace has turned off.
 */

const DISABLED: Record<WorkspaceFeature, { code: string; message: string }> = {
  dependencies: { code: "DEPENDENCIES_DISABLED", message: "dependencies are disabled for this workspace" },
  timeline: { code: "TIMELINE_DISABLED", message: "start dates and the timeline are disabled for this workspace" },
  inProgress: { code: "IN_PROGRESS_DISABLED", message: "time in progress is disabled for this workspace" },
};

export function featureDisabledError(feature: WorkspaceFeature): AppError {
  const { code, message } = DISABLED[feature];
  return new AppError(403, code, message, { feature });
}

/** Columns for a query that already joins `workspace` and `client`. */
export const workspaceFeatureColumns = {
  organisationDependenciesEnabled: clients.dependenciesEnabled,
  organisationTimelineEnabled: clients.timelineEnabled,
  organisationInProgressEnabled: clients.inProgressEnabled,
  workspaceDependenciesEnabled: workspaces.dependenciesEnabled,
  workspaceTimelineEnabled: workspaces.timelineEnabled,
  workspaceInProgressEnabled: workspaces.inProgressEnabled,
};

type FeatureColumnRow = { [K in keyof typeof workspaceFeatureColumns]: boolean };

export function featuresFromColumns(row: FeatureColumnRow): WorkspaceFeatures {
  return effectiveWorkspaceFeatures(
    { dependenciesEnabled: row.organisationDependenciesEnabled, timelineEnabled: row.organisationTimelineEnabled, inProgressEnabled: row.organisationInProgressEnabled },
    { dependenciesEnabled: row.workspaceDependenciesEnabled, timelineEnabled: row.workspaceTimelineEnabled, inProgressEnabled: row.workspaceInProgressEnabled },
  );
}

/** SQL for one effective feature in a query that joins `workspace` and `client`. */
export function featureEnabledSql(feature: WorkspaceFeature) {
  switch (feature) {
    case "dependencies": return sql<boolean>`(${clients.dependenciesEnabled} and ${workspaces.dependenciesEnabled})`;
    case "timeline": return sql<boolean>`(${clients.timelineEnabled} and ${workspaces.timelineEnabled})`;
    case "inProgress": return sql<boolean>`(${clients.inProgressEnabled} and ${workspaces.inProgressEnabled})`;
  }
}

export async function loadWorkspaceFeatures(workspaceId: string, tx: Tx = db): Promise<WorkspaceFeatures> {
  const [row] = await tx.select(workspaceFeatureColumns).from(workspaces)
    .innerJoin(clients, eq(clients.id, workspaces.clientId))
    .where(eq(workspaces.id, workspaceId)).limit(1);
  if (!row) throw notFound("workspace not found");
  return featuresFromColumns(row);
}

/** Effective features for many workspaces at once; unknown ids are left out. */
export async function loadWorkspaceFeaturesMap(workspaceIds: readonly string[], tx: Tx = db): Promise<Map<string, WorkspaceFeatures>> {
  const ids = [...new Set(workspaceIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ workspaceId: workspaces.id, ...workspaceFeatureColumns }).from(workspaces)
    .innerJoin(clients, eq(clients.id, workspaces.clientId))
    .where(inArray(workspaces.id, ids));
  return new Map(rows.map((row) => [row.workspaceId, featuresFromColumns(row)]));
}

async function loadBoardFeatures(boardId: string, tx: Tx = db): Promise<WorkspaceFeatures> {
  const [row] = await tx.select(workspaceFeatureColumns).from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .innerJoin(clients, eq(clients.id, workspaces.clientId))
    .where(eq(boards.id, boardId)).limit(1);
  if (!row) throw notFound("board not found");
  return featuresFromColumns(row);
}

export async function assertWorkspaceFeature(workspaceId: string, feature: WorkspaceFeature, tx: Tx = db): Promise<WorkspaceFeatures> {
  const features = await loadWorkspaceFeatures(workspaceId, tx);
  if (!features[feature]) throw featureDisabledError(feature);
  return features;
}

export async function assertBoardFeature(boardId: string, feature: WorkspaceFeature, tx: Tx = db): Promise<WorkspaceFeatures> {
  const features = await loadBoardFeatures(boardId, tx);
  if (!features[feature]) throw featureDisabledError(feature);
  return features;
}

/**
 * Tells every open board in the affected workspaces about their new effective features. Board
 * guests from other organisations never join the owning workspace's room, so this goes to each
 * board's audience rather than to the workspace; the board page refetches on receipt because the
 * server stops reporting a disabled feature's data (blocked counts, running clocks, start dates).
 */
export async function emitWorkspaceFeaturesChanged(scope: { clientId: string } | { workspaceId: string }): Promise<void> {
  const rows = await db.select({ board: boards, ...workspaceFeatureColumns })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .innerJoin(clients, eq(clients.id, workspaces.clientId))
    .where("clientId" in scope ? eq(workspaces.clientId, scope.clientId) : eq(workspaces.id, scope.workspaceId));
  for (const row of rows) {
    await emitToBoardAudience(row.board.id, SERVER_EVENTS.BOARD_UPDATED, {
      board: row.board,
      organisationInProgressEnabled: row.organisationInProgressEnabled,
      features: featuresFromColumns(row),
    }, { workspaceId: row.board.workspaceId });
  }
}

/**
 * Whether one feature is effective for the workspace in `workspaceId`, as a self-contained SQL
 * condition for queries that do not join `workspace` and `client` themselves.
 */
export function workspaceFeatureEnabledSql(feature: WorkspaceFeature, workspaceId: SQLWrapper): SQL {
  const column = { dependencies: "dependencies_enabled", timeline: "timeline_enabled", inProgress: "in_progress_enabled" }[feature];
  return sql`exists (
    select 1 from workspace feature_workspace
    inner join client feature_client on feature_client.id = feature_workspace.client_id
    where feature_workspace.id = ${workspaceId}
      and feature_client.${sql.raw(column)} and feature_workspace.${sql.raw(column)}
  )`;
}
