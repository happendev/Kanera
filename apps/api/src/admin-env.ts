import type { z } from "zod";
import "./load-env.js";
import { createEnvironmentSchema, environmentSchema } from "./env.js";

type AdminEnvironmentSchemaOptions = Parameters<typeof createEnvironmentSchema>[0];

export function createAdminEnvironmentSchema(options?: AdminEnvironmentSchemaOptions) {
  return (options ? createEnvironmentSchema(options) : environmentSchema).superRefine((value, ctx) => {
  if (!value.ADMIN_JWT_SECRET) {
    ctx.addIssue({ code: "custom", path: ["ADMIN_JWT_SECRET"], message: "ADMIN_JWT_SECRET is required for the admin API" });
  }
  if (value.ADMIN_JWT_SECRET === value.JWT_SECRET) {
    ctx.addIssue({ code: "custom", path: ["ADMIN_JWT_SECRET"], message: "ADMIN_JWT_SECRET must differ from JWT_SECRET" });
  }
  });
}

export const adminEnvironmentSchema = createAdminEnvironmentSchema();

export const adminEnv = adminEnvironmentSchema.parse(process.env);
export type AdminEnv = z.infer<typeof adminEnvironmentSchema>;
