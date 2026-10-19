import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAN_USAGE_WARNING_PERCENT, planUsageLevel, planUsagePercent } from "@kanera/shared/dto";
import { getEntitlements, projectPlanUsage } from "./tier-limits.js";

// Failure modes covered here, which the E2E suite cannot pin down cheaply:
// - an unlimited (null) or zero cap divides by zero or renders a bar;
// - rounding claims "limit reached" before the count actually equals the cap;
// - the seat meter caps a trial, or misses the purchased pool on an active/past-due subscription;
// - the execution window's reset date is wrong across a year boundary.

const hosted = {
  KANERA_DEPLOYMENT_MODE: "hosted" as const,
  HOSTED_FREE_MAX_BOARDS: 3,
  HOSTED_FREE_MAX_ORG_MEMBERS: 5,
  HOSTED_FREE_MAX_ENABLED_AUTOMATIONS: 3,
  HOSTED_FREE_MAX_AUTOMATION_EXECUTIONS_MONTHLY: 100,
  HOSTED_FREE_API_RATE_LIMIT_PER_SECOND: 5,
  HOSTED_FREE_API_RATE_LIMIT_PER_MINUTE: 60,
  PUBLIC_API_KEY_RATE_LIMIT_PER_SECOND: 20,
  PUBLIC_API_KEY_RATE_LIMIT_PER_MINUTE: 600,
};

const counts = { boards: 2, members: 4, paidGuestSeats: 2, enabledAutomations: 3, automationExecutions: 42 };
const meter = (usage: ReturnType<typeof projectPlanUsage>, key: string) => usage.meters.find((m) => m.key === key);

void test("plan usage levels: unlimited, ok, warning at the shared threshold, and limit only at the cap", () => {
  assert.equal(planUsageLevel(10, null), "unlimited");
  assert.equal(planUsagePercent(10, null), null);
  assert.equal(planUsageLevel(0, 0), "limit");
  assert.equal(planUsagePercent(0, 0), 100);
  assert.equal(planUsageLevel(79, 100), "ok");
  assert.equal(planUsageLevel(PLAN_USAGE_WARNING_PERCENT, 100), "warning");
  // 99.6% rounds to 100 but one slot is still free.
  assert.equal(planUsagePercent(249, 250), 100);
  assert.equal(planUsageLevel(249, 250), "warning");
  assert.equal(planUsageLevel(250, 250), "limit");
  assert.equal(planUsagePercent(7, 5), 100, "over-cap usage after a downgrade clamps the bar");
  assert.equal(planUsageLevel(7, 5), "limit");
});

void test("a Free organisation meters members, boards, automations and this month's executions against the Free caps", () => {
  const now = new Date("2026-12-15T10:00:00Z");
  const usage = projectPlanUsage(getEntitlements("free", "none", null, hosted), { billingStatus: "none", seatLimit: 1 }, counts, now);
  assert.equal(usage.tier, "free");
  assert.deepEqual(meter(usage, "boards"), { key: "boards", used: 2, limit: 3, resetsAt: null });
  assert.deepEqual(meter(usage, "members"), { key: "members", used: 4, limit: 5, resetsAt: null });
  assert.equal(meter(usage, "seats"), undefined);
  assert.deepEqual(meter(usage, "activeAutomations"), { key: "activeAutomations", used: 3, limit: 3, resetsAt: null });
  assert.deepEqual(meter(usage, "automationExecutions"), {
    key: "automationExecutions",
    used: 42,
    limit: 100,
    resetsAt: "2027-01-01T00:00:00.000Z",
  });
});

void test("a trial is unlimited, including seats, and does not report an unmetered execution count", () => {
  const usage = projectPlanUsage(getEntitlements("paid", "trialing", new Date(), hosted), { billingStatus: "trialing", seatLimit: 1 }, counts, new Date());
  assert.equal(usage.tier, "trial");
  for (const m of usage.meters) assert.equal(m.limit, null, m.key);
  assert.deepEqual(meter(usage, "seats"), { key: "seats", used: 6, limit: null, resetsAt: null });
  assert.equal(meter(usage, "automationExecutions")?.used, null);
});

void test("Pro caps only the purchased seat pool, and only while the subscription is active or past due", () => {
  for (const billingStatus of ["active", "past_due"] as const) {
    const usage = projectPlanUsage(getEntitlements("paid", billingStatus, null, hosted), { billingStatus, seatLimit: 8 }, counts, new Date());
    assert.equal(usage.tier, "paid");
    assert.deepEqual(meter(usage, "seats"), { key: "seats", used: 6, limit: 8, resetsAt: null });
    assert.equal(meter(usage, "boards")?.limit, null);
    assert.equal(meter(usage, "activeAutomations")?.limit, null);
  }
});
