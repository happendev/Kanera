import { clientMembers, users, type ClientRole } from "@kanera/shared/schema";
import type { Db } from "../db.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type LegacyUserFixture = typeof users.$inferInsert & {
  clientRole?: ClientRole;
  suspendedAt?: Date | null;
  removedAt?: Date | null;
};

/**
 * Transitional integration-fixture adapter for the final multi-organisation schema. Tests used to
 * express a user's one organisation, role, and status in a single user insert. Keeping that compact
 * fixture vocabulary here makes every old scenario create the real identity + membership pair and
 * prevents tests from accidentally exercising an identity with no organisation membership.
 */
export function insertTestUsers(tx: Tx, input: LegacyUserFixture | LegacyUserFixture[]) {
  const fixtures = Array.isArray(input) ? input : [input];
  let result: Promise<Array<typeof users.$inferSelect>> | null = null;
  const execute = () => {
    result ??= (async () => {
      const identities = fixtures.map(({ clientRole: _clientRole, suspendedAt: _suspendedAt, removedAt: _removedAt, ...identity }) => ({
        ...identity,
        activeClientId: identity.activeClientId ?? identity.clientId,
      }));
      const rows = await tx.insert(users).values(identities).returning();
      await tx.insert(clientMembers).values(rows.map((row, index) => ({
        clientId: row.clientId,
        userId: row.id,
        clientRole: fixtures[index]?.clientRole ?? "member",
        suspendedAt: fixtures[index]?.suspendedAt ?? null,
        removedAt: fixtures[index]?.removedAt ?? null,
        addedAt: row.createdAt,
      })));
      return rows;
    })();
    return result;
  };

  return {
    returning: (_selection?: unknown) => execute(),
    then: <TResult1 = Array<typeof users.$inferSelect>, TResult2 = never>(
      onfulfilled?: ((value: Array<typeof users.$inferSelect>) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => execute().then(onfulfilled, onrejected),
  };
}
