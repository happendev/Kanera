import { resolveClientIp } from "@kanera/shared/client-ip";
import type { FastifyRequest } from "fastify";

export { isCloudflarePeer, resolveClientIp } from "@kanera/shared/client-ip";

export function clientIpForRequest(req: FastifyRequest) {
  return resolveClientIp({
    headers: req.headers,
    remoteAddress: req.socket.remoteAddress,
    fallbackIp: req.ip,
  });
}
