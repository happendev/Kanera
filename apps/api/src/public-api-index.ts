import { env } from "./env.js";
import { buildPublicApiServer } from "./public-api-server.js";
import { sendOpsAlert } from "./lib/ops-alerts.js";
import { pool } from "./db.js";
import { installGracefulShutdown } from "./lib/graceful-shutdown.js";

const app = await buildPublicApiServer();
installGracefulShutdown({ app, closeResources: () => pool.end(), service: "public-api" });

try {
  await app.listen({ port: env.PUBLIC_API_PORT, host: "0.0.0.0" });
  void sendOpsAlert({ service: "public-api", type: "startup", port: env.PUBLIC_API_PORT }, { log: app.log });
} catch (err) {
  app.log.error(err);
  await app.close();
  await pool.end();
  process.exit(1);
}
