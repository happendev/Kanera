import { adminEnv as env } from "./admin-env.js";
import { buildAdminServer } from "./admin-server.js";
import { sendOpsAlert } from "./lib/ops-alerts.js";
import { pool } from "./db.js";
import { installGracefulShutdown } from "./lib/graceful-shutdown.js";

const app = await buildAdminServer({ serveWebApp: env.NODE_ENV === "production" });
installGracefulShutdown({ app, closeResources: () => pool.end(), service: "admin-api" });

try {
  await app.listen({ port: env.ADMIN_API_PORT, host: "0.0.0.0" });
  void sendOpsAlert({ service: "admin-api", type: "startup", port: env.ADMIN_API_PORT }, { log: app.log });
} catch (err) {
  app.log.error(err);
  await app.close();
  await pool.end();
  process.exit(1);
}
