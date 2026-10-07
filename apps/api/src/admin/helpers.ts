import type { FastifyRequest } from "fastify";
import { forbidden } from "../lib/errors.js";

export function requireSuperadmin(req: FastifyRequest) {
  if (req.adminAuth.role !== "superadmin") throw forbidden("superadmin required");
}

/** Nullable timestamps as the admin API serialises them. */
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
