import { adminEnv as env } from "./admin-env.js";
import { buildAdminServer } from "./admin-server.js";
import { sendOpsAlert } from "./lib/ops-alerts.js";

const app = await buildAdminServer({ serveWebApp: env.NODE_ENV === "production" });

try {
  await app.listen({ port: env.ADMIN_API_PORT, host: "0.0.0.0" });
  void sendOpsAlert({ service: "admin-api", type: "startup", port: env.ADMIN_API_PORT }, { log: app.log });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
