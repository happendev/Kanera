import { env } from "./env.js";
import { buildPublicApiServer } from "./public-api-server.js";
import { closeServiceResources } from "./lib/close-service-resources.js";
import { installGracefulShutdown } from "./lib/graceful-shutdown.js";

const app = await buildPublicApiServer();
installGracefulShutdown({ app, closeResources: closeServiceResources, service: "public-api" });

try {
  await app.listen({ port: env.PUBLIC_API_PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  try {
    await app.close();
  } finally {
    await closeServiceResources();
  }
  process.exit(1);
}
