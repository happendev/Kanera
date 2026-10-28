/** Minimal identities for one browser test. Deliberately independent of the demo seed. */
import { readFile } from "node:fs/promises";
import { inArray, eq } from "drizzle-orm";
import { clients, clientMembers, users, workspaces, workspaceMembers, oauthGrants, workspaceApiKeys, activityEvents, inviteTokens, boardInvitations, type ClientRole } from "@kanera/shared/schema";
import { db, pool } from "../db.js";
import { hashPassword } from "../auth/password.js";

// This helper performs direct setup/teardown only in the runner's disposable database.
const target = new URL(process.env.DATABASE_URL!);
if (target.hostname !== "localhost" || target.port !== "55434" || target.pathname !== "/kanera_test_e2e") {
  throw new Error("E2E accounts require the isolated database on localhost:55434/kanera_test_e2e");
}
const [action, manifestPath] = process.argv.slice(2);
if (!manifestPath || !["create", "delete"].includes(action ?? "")) throw new Error("Expected create|delete <manifest.json>");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  clientIds: [string, string];
  password: string;
  users: { email: string; name: string; role: ClientRole; external: boolean }[];
};
try {
  if (action === "delete") {
    // Cascades remove identities and their work, preferences and credentials. Restrict deletion to
    // this test's recorded IDs; never truncate tables while the real worker/outboxes are running.
    await db.transaction(async (tx) => {
      // OAuth grants and personal credentials deliberately retain restrictive organisation FKs,
      // even after revocation. Remove this test's credentials before deleting their owners.
      await tx.delete(oauthGrants).where(inArray(oauthGrants.orgClientId, manifest.clientIds));
      await tx.delete(workspaceApiKeys).where(inArray(workspaceApiKeys.createdById,
        tx.select({ id: users.id }).from(users).where(inArray(users.clientId, manifest.clientIds))));
      // Delete content before identities: card route keys and authored activity retain restrictive
      // references that a single client cascade cannot necessarily satisfy in trigger order.
      await tx.delete(workspaces).where(inArray(workspaces.clientId, manifest.clientIds));
      await tx.delete(activityEvents).where(inArray(activityEvents.clientId, manifest.clientIds));
      await tx.delete(inviteTokens).where(inArray(inviteTokens.clientId, manifest.clientIds));
      await tx.delete(boardInvitations).where(inArray(boardInvitations.clientId, manifest.clientIds));
      await tx.delete(clients).where(inArray(clients.id, manifest.clientIds));
    });
  } else {
    const passwordHash = await hashPassword(manifest.password);
    await db.transaction(async (tx) => {
      for (const [index, clientId] of manifest.clientIds.entries()) {
        await tx.insert(clients).values({ id: clientId, name: index ? "E2E External organisation" : "E2E Organisation", storageConfig: { kind: "local" }, analyticsExcluded: true });
        // An empty home workspace prevents normal authentication tests entering onboarding.
        // Scenario boards, cards, fields and guest grants are created separately through the API.
        const [workspace] = await tx.insert(workspaces).values({ clientId, name: "E2E Home", timeZone: "UTC" }).returning();
        for (const person of manifest.users.filter((person) => person.external === Boolean(index))) {
          const [user] = await tx.insert(users).values({
            clientId, activeClientId: clientId, email: person.email, displayName: person.name,
            passwordHash, emailVerifiedAt: new Date(), timezone: "UTC", locale: "en-GB",
          }).returning();
          await tx.insert(clientMembers).values({ clientId, userId: user!.id, clientRole: person.role });
          await tx.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: user!.id, role: person.role === "member" ? "member" : "admin" });
          if (person.role === "owner") await tx.update(clients).set({ createdByUserId: user!.id }).where(eq(clients.id, clientId));
        }
      }
    });
  }
} finally {
  await pool.end();
}
