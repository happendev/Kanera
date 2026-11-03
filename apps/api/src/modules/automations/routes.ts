import { dto } from "@kanera/shared";
import { automationRuns, automations } from "@kanera/shared/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertWorkspaceAccess } from "../../lib/access.js";
import { loadAutomations } from "../../lib/automations.js";
import { notFound } from "../../lib/errors.js";
import { emitToWorkspaceAdmins } from "../../realtime/emit.js";
import { createAutomation } from "./create-automation.js";
import { deleteAutomation } from "./delete-automation.js";
import { moveAutomation } from "./move-automation.js";
import { replaceAutomationActions } from "./replace-automation-actions.js";
import { capturePremiumAutomationRuleUse, loadAutomationRow } from "./route-support.js";
import { updateAutomation } from "./update-automation.js";

export async function automationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/workspaces/:wsId/automations", async (req) => {
    const { wsId: workspaceId } = req.params as { wsId: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    return loadAutomations(workspaceId);
  });

  app.get("/automations/:id/executions", async (req) => {
    const { id } = req.params as { id: string };
    const query = dto.listAutomationExecutionsQuery.parse(req.query);
    const [current] = await db
      .select({ workspaceId: automations.workspaceId })
      .from(automations)
      .where(and(eq(automations.id, id), isNull(automations.archivedAt)))
      .limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    return db
      .select({ id: automationRuns.id, outcome: automationRuns.outcome, cardId: automationRuns.cardId, actionType: automationRuns.actionType, error: automationRuns.error, ranAt: automationRuns.ranAt })
      .from(automationRuns)
      .where(eq(automationRuns.automationId, id))
      .orderBy(desc(automationRuns.ranAt), desc(automationRuns.id))
      .limit(query.limit ?? 101)
      .offset(query.offset);
  });

  app.post("/workspaces/:wsId/automations", async (req, reply) => {
    const { wsId: workspaceId } = req.params as { wsId: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const body = dto.createAutomationBody.parse(req.body);
    const automation = await createAutomation({ auth: req.auth, workspaceId, clientId, body });
    await emitToWorkspaceAdmins(workspaceId, "automation:created", { workspaceId, automation });
    if (body.enabled) void capturePremiumAutomationRuleUse({
      clientId,
      workspaceId,
      actorId: req.auth.sub,
      supportSession: req.auth.authKind === "support",
    });
    return reply.status(201).send(automation);
  });

  app.patch("/automations/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateAutomationBody.parse(req.body);
    const current = await loadAutomationRow(id);
    const { clientId } = await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    const automation = await updateAutomation({ auth: req.auth, automation: current, clientId, body });
    await emitToWorkspaceAdmins(current.workspaceId, "automation:updated", { workspaceId: current.workspaceId, automation });
    if (body.enabled === true && !current.enabled) void capturePremiumAutomationRuleUse({
      clientId,
      workspaceId: current.workspaceId,
      actorId: req.auth.sub,
      supportSession: req.auth.authKind === "support",
    });
    return automation;
  });

  app.put("/automations/:id/actions", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.setAutomationActionsBody.parse(req.body);
    const current = await loadAutomationRow(id);
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    const automation = await replaceAutomationActions({ auth: req.auth, automation: current, body });
    await emitToWorkspaceAdmins(current.workspaceId, "automation:updated", { workspaceId: current.workspaceId, automation });
    return automation;
  });

  app.post("/automations/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveAutomationBody.parse(req.body);
    const current = await loadAutomationRow(id);
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    const { position, prevPosition, rebalancedPositions } = await moveAutomation({ auth: req.auth, automation: current, body });
    if (rebalancedPositions) {
      await emitToWorkspaceAdmins(current.workspaceId, "automation:rebalanced", { workspaceId: current.workspaceId, positions: rebalancedPositions });
    }
    await emitToWorkspaceAdmins(current.workspaceId, "automation:moved", { workspaceId: current.workspaceId, automationId: id, position, prevPosition });
    return { id, position };
  });

  app.delete("/automations/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const current = await loadAutomationRow(id);
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    await deleteAutomation({ auth: req.auth, automation: current });
    await emitToWorkspaceAdmins(current.workspaceId, "automation:deleted", { workspaceId: current.workspaceId, automationId: id });
    return reply.status(204).send();
  });
}
