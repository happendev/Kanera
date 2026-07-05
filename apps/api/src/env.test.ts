import assert from "node:assert/strict";
import { test } from "node:test";
import "./test/setup.js";
import { adminEnvironmentSchema } from "./admin-env.js";
import { mainApiEnvironmentSchema } from "./env.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost/kanera",
  REDIS_URL: "redis://localhost:6379/0",
  JWT_SECRET: "tenant-secret-at-least-sixteen",
  MFA_ENCRYPTION_KEY: "mfa-encryption-secret-at-least-thirty-two-characters",
  MEDIA_SIGNING_SECRET: "media-signing-secret-at-least-thirty-two-characters",
  ADMIN_JWT_SECRET: "admin-secret-at-least-sixteen",
};

void test("self-hosted admin validates without Stripe", () => {
  assert.equal(adminEnvironmentSchema.safeParse({ ...base, KANERA_DEPLOYMENT_MODE: "self_hosted" }).success, true);
});

void test("hosted admin validates without Stripe", () => {
  assert.equal(adminEnvironmentSchema.safeParse({ ...base, KANERA_DEPLOYMENT_MODE: "hosted" }).success, true);
});

void test("admin requires ADMIN_JWT_SECRET", () => {
  const { ADMIN_JWT_SECRET: _omitted, ...withoutAdminSecret } = base;
  const result = adminEnvironmentSchema.safeParse(withoutAdminSecret);
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues.some((issue) => issue.path[0] === "ADMIN_JWT_SECRET"), true);
});

void test("empty ADMIN_WEB_ORIGIN uses the local default", () => {
  const result = adminEnvironmentSchema.safeParse({ ...base, ADMIN_WEB_ORIGIN: "" });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.ADMIN_WEB_ORIGIN, "http://localhost:4300");
});

void test("hosted main API requires complete Stripe configuration", () => {
  const result = mainApiEnvironmentSchema.safeParse({ ...base, KANERA_DEPLOYMENT_MODE: "hosted" });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues.some((issue) => issue.path[0] === "STRIPE_SECRET_KEY"), true);
});

void test("production rejects documented development secrets", () => {
  for (const [key, value] of Object.entries({
    JWT_SECRET: "change-me-to-a-long-random-string",
    MFA_ENCRYPTION_KEY: "change-me-to-a-distinct-32-character-random-string",
    MEDIA_SIGNING_SECRET: "change-me-to-a-separate-long-random-string",
    ADMIN_JWT_SECRET: "change-me-to-a-distinct-long-random-string",
  })) {
    const result = environmentResult({ ...base, NODE_ENV: "production", [key]: value });
    assert.equal(result.success, false, `${key} placeholder should be rejected`);
    if (!result.success) assert.equal(result.error.issues.some((issue) => issue.path[0] === key), true);
  }
});

void test("development continues to accept documented development secrets", () => {
  const result = mainApiEnvironmentSchema.safeParse({
    ...base,
    NODE_ENV: "development",
    JWT_SECRET: "change-me-to-a-long-random-string",
    MFA_ENCRYPTION_KEY: "change-me-to-a-distinct-32-character-random-string",
    MEDIA_SIGNING_SECRET: "change-me-to-a-separate-long-random-string",
  });
  assert.equal(result.success, true);
});

function environmentResult(input: Record<string, unknown>) {
  return mainApiEnvironmentSchema.safeParse(input);
}
