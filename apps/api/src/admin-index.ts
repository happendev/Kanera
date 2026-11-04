import { adminEnv as env } from "./admin-env.js";
import { buildAdminServer } from "./admin-server.js";
import { closeServiceResources } from "./lib/close-service-resources.js";
import { installGracefulShutdown } from "./lib/graceful-shutdown.js";

const app = await buildAdminServer({ serveWebApp: env.NODE_ENV === "production" });
installGracefulShutdown({ app, closeResources: closeServiceResources, service: "admin-api" });

try {
  await app.listen({ port: env.ADMIN_API_PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  try {
    await app.close();
  } finally {
    await closeServiceResources();
  }
  process.exit(1);
}
