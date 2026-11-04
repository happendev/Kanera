import { env } from "./env.js";
import { buildWorkerServer } from "./worker-server.js";
import { closeServiceResources } from "./lib/close-service-resources.js";
import { installGracefulShutdown } from "./lib/graceful-shutdown.js";

const app = await buildWorkerServer();
installGracefulShutdown({ app, closeResources: closeServiceResources, service: "worker" });

try {
  await app.listen({ port: env.WORKER_PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  try {
    await app.close();
  } finally {
    await closeServiceResources();
  }
  process.exit(1);
}
