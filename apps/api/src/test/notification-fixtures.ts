import { notifications, workspaces } from "@kanera/shared/schema";
import { inArray } from "drizzle-orm";
import type { Db } from "../db.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type LegacyNotificationFixture = Omit<typeof notifications.$inferInsert, "clientId"> & { clientId?: string };

/** Resolve the durable organisation from workspace ownership, just as production fanout does. */
export function insertTestNotifications(tx: Tx, input: LegacyNotificationFixture | LegacyNotificationFixture[]) {
  const fixtures = Array.isArray(input) ? input : [input];
  let result: Promise<Array<typeof notifications.$inferSelect>> | null = null;
  const execute = () => {
    result ??= (async () => {
      const workspaceIds = [...new Set(fixtures.filter((row) => !row.clientId).map((row) => row.workspaceId))];
      const workspaceRows = workspaceIds.length === 0
        ? []
        : await tx.select({ id: workspaces.id, clientId: workspaces.clientId }).from(workspaces).where(inArray(workspaces.id, workspaceIds));
      const clientByWorkspace = new Map(workspaceRows.map((row) => [row.id, row.clientId]));
      return tx.insert(notifications).values(fixtures.map((row) => {
        const clientId = row.clientId ?? clientByWorkspace.get(row.workspaceId);
        if (!clientId) throw new Error(`Notification fixture workspace ${row.workspaceId} has no organisation`);
        return { ...row, clientId };
      })).returning();
    })();
    return result;
  };
  return {
    returning: (_selection?: unknown) => execute(),
    then: <TResult1 = Array<typeof notifications.$inferSelect>, TResult2 = never>(
      onfulfilled?: ((value: Array<typeof notifications.$inferSelect>) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => execute().then(onfulfilled, onrejected),
  };
}
