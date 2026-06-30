import assert from "node:assert/strict";
import { test } from "node:test";
import { maxFileBytesForBillingStatus, quotaForBillingStatus } from "./entitlements.js";

const hostedConfig = {
  KANERA_DEPLOYMENT_MODE: "hosted" as const,
  ATTACHMENT_MAX_BYTES: 100 * 1024 * 1024,
  HOSTED_FREE_ATTACHMENT_MAX_BYTES: 5 * 1024 * 1024,
  HOSTED_FREE_STORAGE_QUOTA_BYTES: 524_288_000,
  HOSTED_PAID_STORAGE_QUOTA_BYTES: 214_748_364_800,
};

void test("self-hosted storage quota is unlimited", () => {
  const usage = quotaForBillingStatus("none", {
    ...hostedConfig,
    KANERA_DEPLOYMENT_MODE: "self_hosted",
  });
  assert.equal(usage.limited, false);
  assert.equal(usage.quotaBytes, null);
  assert.equal(usage.remainingBytes, null);
});

void test("hosted free statuses use the free storage quota", () => {
  for (const status of ["none", "canceled"] as const) {
    const usage = quotaForBillingStatus(status, hostedConfig);
    assert.equal(usage.limited, true);
    assert.equal(usage.quotaBytes, 524_288_000);
    assert.equal(usage.remainingBytes, 524_288_000);
  }
});

void test("hosted trialing, active, and past_due statuses use the paid storage quota", () => {
  for (const status of ["trialing", "active", "past_due"] as const) {
    const usage = quotaForBillingStatus(status, hostedConfig, null, "paid");
    assert.equal(usage.limited, true);
    assert.equal(usage.quotaBytes, 214_748_364_800);
    assert.equal(usage.remainingBytes, 214_748_364_800);
  }
});

void test("upload file size limits follow deployment mode and billing status", () => {
  assert.equal(maxFileBytesForBillingStatus("none", { ...hostedConfig, KANERA_DEPLOYMENT_MODE: "self_hosted" }), 100 * 1024 * 1024);
  assert.equal(maxFileBytesForBillingStatus("none", hostedConfig), 5 * 1024 * 1024);
  assert.equal(maxFileBytesForBillingStatus("active", hostedConfig, "paid"), 100 * 1024 * 1024);
});

void test("hosted free plan uses free storage limits even if billing status is stale paid-tier", () => {
  assert.equal(maxFileBytesForBillingStatus("trialing", hostedConfig, "free"), 5 * 1024 * 1024);
  const usage = quotaForBillingStatus("active", hostedConfig, null, "free");
  assert.equal(usage.quotaBytes, hostedConfig.HOSTED_FREE_STORAGE_QUOTA_BYTES);
});

void test("hosted org storage quota can be overridden by the org row", () => {
  const usage = quotaForBillingStatus("active", hostedConfig, 123_456);
  assert.equal(usage.limited, true);
  assert.equal(usage.quotaBytes, 123_456);
  assert.equal(usage.remainingBytes, 123_456);
});

void test("null org storage quota falls back to the billing-tier env quota", () => {
  assert.equal(quotaForBillingStatus("none", hostedConfig, null).quotaBytes, hostedConfig.HOSTED_FREE_STORAGE_QUOTA_BYTES);
  assert.equal(quotaForBillingStatus("active", hostedConfig, null).quotaBytes, hostedConfig.HOSTED_PAID_STORAGE_QUOTA_BYTES);
});

void test("hosted free upload limit cannot exceed the deployment attachment maximum", () => {
  assert.equal(maxFileBytesForBillingStatus("none", {
    ...hostedConfig,
    ATTACHMENT_MAX_BYTES: 4 * 1024 * 1024,
    HOSTED_FREE_ATTACHMENT_MAX_BYTES: 5 * 1024 * 1024,
  }), 4 * 1024 * 1024);
});
