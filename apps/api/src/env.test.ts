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

void test("hosted main API requires complete Stripe configuration", () => {
  const result = mainApiEnvironmentSchema.safeParse({ ...base, KANERA_DEPLOYMENT_MODE: "hosted" });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues.some((issue) => issue.path[0] === "STRIPE_SECRET_KEY"), true);
});
