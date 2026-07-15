import { env } from "./env.js";
import { buildWorkerServer } from "./worker-server.js";
import { pool } from "./db.js";
import { installGracefulShutdown } from "./lib/graceful-shutdown.js";

const app = await buildWorkerServer();
installGracefulShutdown({ app, closeResources: () => pool.end(), service: "worker" });

try {
  await app.listen({ port: env.WORKER_PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  await app.close();
  await pool.end();
  process.exit(1);
}
