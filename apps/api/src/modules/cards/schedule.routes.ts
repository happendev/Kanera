import { dto } from "@kanera/shared";
import type { ScheduleResponse } from "@kanera/shared/dto";
import type { FastifyInstance } from "fastify";
import { loadSchedule } from "../../lib/schedule-graph.js";

/**
 * The Timeline view's schedule, computed server-side by the same engine the browser runs
 * (`@kanera/shared/schedule`), served to the web app and, unchanged, to API clients and agents on
 * `/api/v1` (MCP `cards.schedule`). One handler on both servers so an agent and the person looking
 * at the chart never disagree about slack or the critical path, and so the privacy rules cannot
 * drift: every card is filtered through the caller's board access, exactly as the dependency map is.
 */
export async function scheduleRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // POST like the dependency map: a read with no side effects, kept POST so the scope stays a body.
  app.post("/cards/schedule", async (req): Promise<ScheduleResponse> => {
    const body = dto.scheduleBody.parse(req.body);
    return loadSchedule(req.auth, body);
  });
}
