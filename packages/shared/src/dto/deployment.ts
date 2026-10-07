import { z } from "zod";

// How this Kanera is run (and which environment it is), surfaced to clients for analytics and
// feature gating. Mirrors the API's KANERA_DEPLOYMENT_MODE / KANERA_ENVIRONMENT env parsing.
export const DEPLOYMENT_MODES = ["self_hosted", "hosted"] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];
export const KANERA_ENVIRONMENTS = ["development", "test", "staging", "production"] as const;
export type KaneraEnvironment = (typeof KANERA_ENVIRONMENTS)[number];

export const deploymentModeSchema = z.enum(DEPLOYMENT_MODES);
export const kaneraEnvironmentSchema = z.enum(KANERA_ENVIRONMENTS);
