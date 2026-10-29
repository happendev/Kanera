import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Compare only after access checks and shaping, including renewed signed media URLs. */
export function conditionalCardResponse<T extends { revision?: string }>(req: FastifyRequest, reply: FastifyReply, body: T): T | undefined {
  const { revision, ...representation } = body;
  const etag = `W/"${createHash("sha256").update(JSON.stringify(representation)).digest("base64url")}"`;
  // The drawer owns a bounded in-memory copy. Do not leave private representations in shared or
  // browser HTTP caches; explicit If-None-Match still permits validation of that in-memory copy.
  reply.header("Cache-Control", "private, no-store");
  reply.header("ETag", etag);
  if (revision) reply.header("X-Card-Revision", revision);
  if (req.headers["if-none-match"]?.split(",").map((value) => value.trim()).includes(etag)) {
    void reply.code(304).send();
    return undefined;
  }
  return body;
}
