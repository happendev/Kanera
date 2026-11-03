import { dto } from "@kanera/shared";
import { cardPriorities } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assertCardAccess } from "../../lib/access.js";
import { forbidden, notFound } from "../../lib/errors.js";
import { emitCardPriorityInvalidated } from "../../realtime/emit.js";
import { assertGlobalWorkSeparatorContext } from "../global-work-separators/routes.js";
import { loadPriorities, loadPriorityQueues, loadPriorityTargets } from "./priority-queries.js";
import { addPriority, movePriority, removePriority } from "./priority-queue-writes.js";

export { liveQueueRanksByCardId } from "./priority-queries.js";

/**
 * Authorise one write against the touched card's *own* workspace.
 *
 * Not a queue-level check: "admin of some workspace shared with the target" would let an admin of
 * one small shared workspace reorder entries belonging to workspaces where they have no authority at
 * all — a privilege escalation across exactly the boundary `assertOrganisationContext` and
 * `canAccessWorkspace` exist to guard. `"observer"` rather than `"editor"` because prioritising is
 * not editing the card.
 */
async function assertPriorityWriteAccess(auth: AuthClaims, cardId: string, targetUserId: string) {
  // The "observer" floor below is what lets a viewer sequence work they cannot edit — but it also
  // means the usual scope-to-rank mapping never trips for read-scoped integration credentials, so
  // "read-only credentials cannot mutate" must be enforced here explicitly for the public API.
  if (auth.apiKeyScope === "read") throw forbidden();
  const ctx = await assertCardAccess(auth, cardId, "observer");
  // Your own queue is always yours, so seeing the card is the whole test. The separator context gate
  // additionally requires workspace *membership*, which a cross-organisation guest never has — and
  // holding a card from an external org's board is exactly the case this table exists to support, so
  // deferring to it here would make a guest unable to sequence their own work. For anyone else's
  // queue it is called verbatim, so one implementation of the cross-user rule exists.
  if (targetUserId !== auth.sub) {
    await assertGlobalWorkSeparatorContext({ auth, workspaceId: ctx.workspaceId, targetUserId });
  }
  return ctx;
}

export async function cardPriorityRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Static path, so it never collides with the :userId route below (the router prefers static
  // segments), and "targets" is not a valid user id anyway.
  app.get("/work/priority-targets", async (req) => loadPriorityTargets(req.auth));

  // Static path beside the :userId route, like /work/priority-targets above.
  app.get("/work/priorities", async (req) => loadPriorityQueues(req.auth));

  app.get("/work/priorities/:userId", async (req) => {
    const { userId: targetUserId } = req.params as { userId: string };
    const query = dto.cardPrioritiesQuery.parse(req.query ?? {});
    return loadPriorities(req.auth, targetUserId, query);
  });

  app.post("/work/priorities/:userId/cards", async (req, reply) => {
    const { userId: targetUserId } = req.params as { userId: string };
    const body = dto.createCardPriorityBody.parse(req.body);
    const ctx = await assertPriorityWriteAccess(req.auth, body.cardId, targetUserId);
    await addPriority({ auth: req.auth, targetUserId, workspaceId: ctx.workspaceId, body });

    await emitCardPriorityInvalidated(targetUserId);
    // The full queue, not just the created row: the actor settles optimistically without waiting for
    // their own invalidation echo, and a concurrent reorder by another manager is already folded in.
    return reply.status(201).send(await loadPriorities(req.auth, targetUserId));
  });

  app.post("/card-priorities/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveCardPriorityBody.parse(req.body);
    const [current] = await db.select().from(cardPriorities).where(eq(cardPriorities.id, id)).limit(1);
    if (!current) throw notFound();
    // Checked on the *moved* entry's card only. Anchors are numeric position hints, not things being
    // written; requiring rights over them would make the feature unusable for a workspace admin
    // whose colleague's queue merely contains a card from elsewhere.
    const ctx = await assertPriorityWriteAccess(req.auth, current.cardId, current.targetUserId);

    const noOp = await movePriority({ auth: req.auth, current, workspaceId: ctx.workspaceId, body });

    if (!noOp) await emitCardPriorityInvalidated(current.targetUserId);
    return loadPriorities(req.auth, current.targetUserId);
  });

  app.delete("/card-priorities/:id", async (req) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select().from(cardPriorities).where(eq(cardPriorities.id, id)).limit(1);
    if (!current) throw notFound();
    const ctx = await assertPriorityWriteAccess(req.auth, current.cardId, current.targetUserId);

    const alreadyGone = await removePriority({ auth: req.auth, current, workspaceId: ctx.workspaceId });

    if (!alreadyGone) await emitCardPriorityInvalidated(current.targetUserId);
    return loadPriorities(req.auth, current.targetUserId);
  });
}
