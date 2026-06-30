import { env } from "./env.js";
import { sendOpsAlert } from "./lib/ops-alerts.js";
import { buildWorkerServer } from "./worker-server.js";

const app = await buildWorkerServer();

try {
  await app.listen({ port: env.WORKER_PORT, host: "0.0.0.0" });
  void sendOpsAlert({ service: "worker", type: "startup", port: env.WORKER_PORT }, { log: app.log });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
