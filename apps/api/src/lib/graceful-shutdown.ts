import type { FastifyInstance } from "fastify";

type ShutdownOptions = {
  app: FastifyInstance;
  closeResources?: () => Promise<void>;
  service: string;
};

export function installGracefulShutdown({ app, closeResources, service }: ShutdownOptions): void {
  let shutdownStarted = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shutdownStarted) {
      app.log.warn({ signal, service }, "received a second shutdown signal; forcing exit");
      process.exit(1);
    }
    shutdownStarted = true;
    app.log.info({ signal, service }, "graceful shutdown started");

    try {
      // Fastify stops accepting new work and waits for in-flight requests before running onClose hooks.
      try {
        await app.close();
      } finally {
        // The database must still be drained when an earlier onClose hook fails.
        await closeResources?.();
      }
      app.log.info({ signal, service }, "graceful shutdown complete");
      process.exitCode = 0;
    } catch (error) {
      app.log.error({ err: error, signal, service }, "graceful shutdown failed");
      process.exitCode = 1;
    }
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
