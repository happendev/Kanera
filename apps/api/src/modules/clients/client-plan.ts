import { env } from "../../env.js";
import { badRequest } from "../../lib/errors.js";

/** `POST /clients/me/plan/upgrade`: plan changes go through Stripe checkout, never this endpoint. */
export function upgradeClientPlan(): never {
  if (env.KANERA_DEPLOYMENT_MODE !== "hosted") {
    throw badRequest("plan changes are only available in hosted mode");
  }

  throw badRequest("use /billing/checkout to start a Stripe checkout session");
}

/** `POST /clients/me/plan/cancel`: cancellations go through the Stripe portal, never this endpoint. */
export function cancelClientPlan(): never {
  if (env.KANERA_DEPLOYMENT_MODE !== "hosted") {
    throw badRequest("plan changes are only available in hosted mode");
  }

  throw badRequest("use /billing/portal to manage or cancel a Stripe subscription");
}
