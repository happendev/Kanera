import type { AdminOrgPersonListItem, AdminUserListItem } from "@kanera/shared/dto";

export type AccessTone = "free" | "trial" | "pro";
export type AccessLabel = { label: string; tone: AccessTone };

export interface OrganisationBillingLifecycle {
  plan: string;
  billingStatus: string;
  billingInterval: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export function planTone(plan: string, billingStatus: string): AccessTone {
  if (plan === "paid" && billingStatus === "trialing") return "trial";
  if (plan === "paid" && (billingStatus === "active" || billingStatus === "past_due")) return "pro";
  return "free";
}

export function isSubscribedPlan(plan: string, billingStatus: string): boolean {
  return planTone(plan, billingStatus) === "pro";
}

export function organisationPlanLabel(plan: string, billingStatus: string): "Free" | "Trial" | "Pro" {
  return ({ free: "Free", trial: "Trial", pro: "Pro" } as const)[planTone(plan, billingStatus)];
}

export function membershipAccess(plan: string, billingStatus: string): AccessLabel {
  const tone = planTone(plan, billingStatus);
  return { tone, label: ({ free: "Free member", trial: "Trial member", pro: "Paid member" } as const)[tone] };
}

export function guestAccess(paidGuestSeat: boolean, plan: string, billingStatus: string): AccessLabel {
  const tone = paidGuestSeat ? planTone(plan, billingStatus) : "free";
  return { tone, label: ({ free: "Free guest", trial: "Trial guest", pro: "Paid guest" } as const)[tone] };
}

export function organisationBillingSummary(organisation: OrganisationBillingLifecycle): string {
  const tone = planTone(organisation.plan, organisation.billingStatus);
  if (tone === "free") return "Free · not billed";

  const cadence = organisation.billingInterval === "monthly"
    ? "Monthly"
    : organisation.billingInterval === "annual"
      ? "Annual"
      : tone === "trial"
        ? "Trial"
        : "Billing cadence not synced";
  if (!organisation.currentPeriodEnd) {
    return `${cadence} · ${tone === "trial" ? "trial end" : organisation.cancelAtPeriodEnd ? "expiry" : "renewal"} not synced`;
  }

  const date = new Date(organisation.currentPeriodEnd).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  if (tone === "trial") return `${cadence} · trial ends ${date}`;
  return `${cadence} · ${organisation.cancelAtPeriodEnd ? "expires" : "renews"} ${date}`;
}

export function orgPersonAccessLabel(access: AdminOrgPersonListItem["access"]): string {
  return ({
    free_member: "Free member",
    trial_member: "Trial member",
    pro_member: "Paid member",
    free_guest: "Free guest",
    trial_guest: "Trial guest",
    paid_guest: "Paid guest",
  } as const)[access];
}

export function userAccessBreakdown(user: Pick<AdminUserListItem, "orgs" | "guestOrgs">): Array<AccessLabel & { count: number }> {
  const labels = new Map<string, AccessLabel & { count: number }>();
  const add = (access: AccessLabel) => {
    const current = labels.get(access.label);
    labels.set(access.label, { ...access, count: (current?.count ?? 0) + 1 });
  };
  for (const organisation of user.orgs.filter((item) => !item.suspendedAt && !item.removedAt)) {
    add(membershipAccess(organisation.plan, organisation.billingStatus));
  }
  for (const organisation of user.guestOrgs) {
    add(guestAccess(organisation.paidGuestSeat, organisation.plan, organisation.billingStatus));
  }
  return [...labels.values()];
}
