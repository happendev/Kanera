import { boards, workspaces } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db.js";
import { badRequest } from "../../lib/errors.js";

export async function resolveImportTargetBoard(workspaceId: string): Promise<string | null> {
  const [workspace] = await db.select({ kind: workspaces.kind }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (workspace?.kind !== "board") return null;

  const rows = await db.select({ id: boards.id }).from(boards).where(eq(boards.workspaceId, workspaceId));
  // A standalone import appends into its one visible board. Checking the route-level invariant here
  // prevents a damaged hidden workspace from making an arbitrary board the import destination.
  if (rows.length !== 1) throw badRequest("standalone board configuration must contain exactly one board");
  return rows[0]!.id;
}
