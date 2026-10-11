import { requestContext } from "@fastify/request-context";

export type ApiRateTier = "free" | "paid";

/**
 * Request-scoped hook the public API installs for credential (API key / agent) requests. Agent rate
 * limits follow the organisation that owns the resource a request touches: the access helpers report
 * each organisation they resolve, and the meter charges that organisation's per-user buckets at its
 * plan's limits (waiting in the queue, or throwing RATE_LIMITED). The app server never installs one,
 * so interactive web traffic is unaffected.
 */
export interface ApiOrganisationMeter {
  charge(clientId: string, tier: ApiRateTier): Promise<void>;
}

declare module "@fastify/request-context" {
  interface RequestContextData {
    apiOrganisationMeter?: ApiOrganisationMeter;
  }
}

export async function meterApiOrganisation(clientId: string, tier: ApiRateTier): Promise<void> {
  await requestContext.get("apiOrganisationMeter")?.charge(clientId, tier);
}
