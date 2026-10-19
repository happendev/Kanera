import { dto } from "@kanera/shared";
import type { DependencyGraphResponse } from "@kanera/shared/dto";
import type { FastifyInstance } from "fastify";
import { loadDependencyGraph } from "../../lib/dependency-graph.js";

/**
 * The dependency map behind the Dependencies view, served to the web app and, unchanged, to API
 * clients and agents on `/api/v1` (MCP `cards.dependency_graph`, CLI `kanera deps`, SDK
 * `cards.dependencyGraph`). One handler on both servers so the privacy walk cannot drift: every
 * card is filtered through the caller's board access, and workspace keys only resolve boards in
 * their own workspace (assertBoardAccess). The board/list/label/people lookups stay in the public
 * shape: they only name what the returned cards already reveal, and spare a client one read per
 * board it has never seen.
 */
export async function dependencyGraphRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // POST only because a card-id scope can be long; it is a read with no side effects.
  app.post("/cards/dependency-graph", async (req): Promise<DependencyGraphResponse> => {
    const body = dto.dependencyGraphBody.parse(req.body);
    return loadDependencyGraph(req.auth, body);
  });
}
