import { dto } from "@kanera/shared";
import type { HomeActivityResponse, HomeGettingStartedResponse, HomeTodayResponse } from "@kanera/shared/dto";
import type { FastifyInstance } from "fastify";
import { loadHomeActivity } from "./activity.js";
import { loadGettingStarted, updateGettingStarted } from "./getting-started.js";
import { loadHomeToday } from "./today.js";

export async function homeRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  /**
   * The signed-in user's day: what is overdue or due within a week, and how much they have
   * completed recently. Internal only — deliberately not registered on the public API server, and
   * not listed in the public OpenAPI document.
   *
   * GET rather than POST because home is a fixed, opinionated view with no scope or filter body,
   * unlike the `/work/*` family.
   */
  app.get("/home/today", async (req): Promise<HomeTodayResponse> => loadHomeToday({ auth: req.auth, query: req.query, log: req.log }));


  /**
   * The "Getting started" checklist. Separate from /home/today because it changes on a different
   * rhythm (rarely, and mostly from other pages) and once closed it is never asked for again,
   * whereas /home/today polls and is cached for offline use.
   */
  app.get("/home/getting-started", async (req): Promise<HomeGettingStartedResponse> => loadGettingStarted(req.auth));

  /**
   * The home "My recent activity" panel. Separate from /home/today so a slow or failed feed never
   * holds up the agenda, and it is not cached offline: it is a recap, not something to act on.
   */
  app.get("/home/activity", async (req): Promise<HomeActivityResponse> => loadHomeActivity(req.auth));

  /** A personal UI flag, like the preferences on PATCH /auth/me: no activity row and no event. */
  app.patch("/home/getting-started", async (req): Promise<HomeGettingStartedResponse> => {
    const body = dto.updateHomeGettingStartedBody.parse(req.body ?? {});
    await updateGettingStarted(req.auth.sub, body);
    return loadGettingStarted(req.auth);
  });
}
