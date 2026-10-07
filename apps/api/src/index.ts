import { buildServer } from "./server.js";
import { env } from "./env.js";
import { pool } from "./db.js";
import { installGracefulShutdown } from "./lib/graceful-shutdown.js";

// Background schedulers live in the worker process (worker-index.ts); this process serves requests
// and realtime only.
const app = await buildServer();
installGracefulShutdown({ app, closeResources: () => pool.end(), service: "api" });

try {
  await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
} catch (err) {
  if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
    app.log.error(
      { port: env.API_PORT },
      `API port ${env.API_PORT} is already in use. Stop the Kanera process that owns it or set API_PORT to another free port; no process was terminated.`,
    );
  } else {
    app.log.error(err);
  }
  await app.close();
  await pool.end();
  process.exit(1);
}
