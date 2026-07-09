import type { FastifyInstance, FastifyError } from "fastify";
import { ZodError } from "zod";
import { sendOpsAlert, type AlertService } from "./ops-alerts.js";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const forbidden = (msg = "forbidden") => new AppError(403, "FORBIDDEN", msg);
export const notFound = (msg = "not found") => new AppError(404, "NOT_FOUND", msg);
export const conflict = (msg = "conflict") => new AppError(409, "CONFLICT", msg);
export const badRequest = (msg = "bad request") => new AppError(400, "BAD_REQUEST", msg);
export const unauthorized = (msg = "unauthorized") => new AppError(401, "UNAUTHORIZED", msg);
export const tooManyRequests = (msg = "rate limit exceeded") => new AppError(429, "RATE_LIMITED", msg);

export function registerErrorHandler(app: FastifyInstance, options: { service?: AlertService } = {}) {
  const service = options.service ?? "api";
  app.setErrorHandler((err: FastifyError | AppError | ZodError, req, reply) => {
    // Never let a shared cache store an error. Signed-media URLs (`*.png` etc.)
    // 404 once their token expires, and Cloudflare negative-caches 4xx for
    // cacheable extensions by default — that turns one expired hit into a sticky
    // edge 404 (cf-cache HIT) for everyone, even after a valid retry exists.
    // `no-store` on every error response keeps negative results from being cached.
    reply.header("Cache-Control", "no-store");
    if (err instanceof ZodError) {
      return reply.status(400).send({ code: "VALIDATION", message: "validation failed", issues: err.issues });
    }
    if (err instanceof AppError) {
      // AppError is often a deliberate client-facing shape, but 5xx variants still
      // represent server failures and should be visible in dev terminals and server logs.
      if (err.statusCode >= 500) req.log.error({ err }, "server error");
      return reply.status(err.statusCode).send({ code: err.code, message: err.message, ...(err.details ?? {}) });
    }
    if (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
      // Fastify can reject malformed client requests before a route handler runs
      // (for example, an unsupported Content-Type on a bodyless cookie-refresh POST).
      // Preserve those as client errors so operational alerts stay focused on server faults.
      return reply.status(err.statusCode).send({
        code: err.code ?? "BAD_REQUEST",
        message: err.message,
      });
    }
    req.log.error({ err }, "unhandled error");
    void sendOpsAlert({
      service,
      type: "error",
      requestId: req.id,
      method: req.method,
      url: req.url,
      statusCode: 500,
      error: err,
    }, { log: req.log });
    return reply.status(500).send({ code: "INTERNAL", message: "internal error" });
  });
}
