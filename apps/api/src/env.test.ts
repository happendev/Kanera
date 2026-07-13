import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import "./test/setup.js";
import { adminEnvironmentSchema, createAdminEnvironmentSchema } from "./admin-env.js";
import { createMainApiEnvironmentSchema, mainApiEnvironmentSchema } from "./env.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost/kanera",
  REDIS_URL: "redis://localhost:6379/0",
  JWT_SECRET: "tenant-secret-at-least-sixteen",
  SECRETS_ENCRYPTION_KEY: "secrets-encryption-key-at-least-thirty-two-characters",
  MFA_ENCRYPTION_KEY: "mfa-encryption-secret-at-least-thirty-two-characters",
  MEDIA_SIGNING_SECRET: "media-signing-secret-at-least-thirty-two-characters",
  ADMIN_JWT_SECRET: "admin-secret-at-least-sixteen",
};
const hostedStripe = {
  STRIPE_SECRET_KEY: "sk_test_local",
  STRIPE_PUBLISHABLE_KEY: "pk_test_local",
  STRIPE_WEBHOOK_SECRET: "whsec_test_local",
  STRIPE_PRICE_ID_PRO_MONTHLY: "price_local_monthly",
  STRIPE_PRICE_ID_PRO_ANNUAL: "price_local_annual",
};
const hostedModeToken = "test-only-hosted-mode-token";
const hostedModeTokenSha256 = createHash("sha256").update(hostedModeToken, "utf8").digest("hex");

void test("self-hosted admin validates without Stripe", () => {
  assert.equal(adminEnvironmentSchema.safeParse({ ...base, KANERA_DEPLOYMENT_MODE: "self_hosted" }).success, true);
});

void test("hosted admin validates without Stripe", () => {
  assert.equal(adminEnvironmentSchema.safeParse({ ...base, KANERA_DEPLOYMENT_MODE: "hosted" }).success, true);
});

void test("production hosted admin requires hosted mode token", () => {
  const result = adminEnvironmentSchema.safeParse({ ...base, NODE_ENV: "production", KANERA_DEPLOYMENT_MODE: "hosted" });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues.some((issue) => issue.path[0] === "KANERA_HOSTED_MODE_TOKEN"), true);
});

void test("production hosted admin accepts matching hosted mode token", () => {
  const schema = createAdminEnvironmentSchema({ hostedModeTokenSha256 });
  const result = schema.safeParse({
    ...base,
    NODE_ENV: "production",
    KANERA_DEPLOYMENT_MODE: "hosted",
    KANERA_HOSTED_MODE_TOKEN: hostedModeToken,
  });
  assert.equal(result.success, true);
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

void test("production hosted main API rejects missing hosted mode token", () => {
  const result = mainApiEnvironmentSchema.safeParse({
    ...base,
    ...hostedStripe,
    NODE_ENV: "production",
    KANERA_DEPLOYMENT_MODE: "hosted",
  });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues.some((issue) => issue.path[0] === "KANERA_HOSTED_MODE_TOKEN"), true);
});

void test("production hosted main API rejects wrong hosted mode token", () => {
  const schema = createMainApiEnvironmentSchema({ hostedModeTokenSha256 });
  const result = schema.safeParse({
    ...base,
    ...hostedStripe,
    NODE_ENV: "production",
    KANERA_DEPLOYMENT_MODE: "hosted",
    KANERA_HOSTED_MODE_TOKEN: "wrong-token",
  });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues.some((issue) => issue.path[0] === "KANERA_HOSTED_MODE_TOKEN"), true);
});

void test("production hosted main API accepts matching hosted mode token with Stripe configuration", () => {
  const schema = createMainApiEnvironmentSchema({ hostedModeTokenSha256 });
  const result = schema.safeParse({
    ...base,
    ...hostedStripe,
    NODE_ENV: "production",
    KANERA_DEPLOYMENT_MODE: "hosted",
    KANERA_HOSTED_MODE_TOKEN: hostedModeToken,
  });
  assert.equal(result.success, true);
});

void test("production self-hosted main API does not require hosted mode token", () => {
  const result = mainApiEnvironmentSchema.safeParse({ ...base, NODE_ENV: "production", KANERA_DEPLOYMENT_MODE: "self_hosted" });
  assert.equal(result.success, true);
});

void test("development hosted main API does not require hosted mode token", () => {
  const result = mainApiEnvironmentSchema.safeParse({
    ...base,
    ...hostedStripe,
    NODE_ENV: "development",
    KANERA_DEPLOYMENT_MODE: "hosted",
  });
  assert.equal(result.success, true);
});

void test("development hosted main API requires token when web origin is not local", () => {
  const result = mainApiEnvironmentSchema.safeParse({
    ...base,
    ...hostedStripe,
    NODE_ENV: "development",
    WEB_ORIGIN: "https://kanera.example.com",
    KANERA_DEPLOYMENT_MODE: "hosted",
  });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues.some((issue) => issue.path[0] === "KANERA_HOSTED_MODE_TOKEN"), true);
});

void test("development hosted main API accepts matching token when web origin is not local", () => {
  const schema = createMainApiEnvironmentSchema({ hostedModeTokenSha256 });
  const result = schema.safeParse({
    ...base,
    ...hostedStripe,
    NODE_ENV: "development",
    WEB_ORIGIN: "https://kanera.example.com",
    KANERA_DEPLOYMENT_MODE: "hosted",
    KANERA_HOSTED_MODE_TOKEN: hostedModeToken,
  });
  assert.equal(result.success, true);
});

void test("development hosted main API requires token when database is not local", () => {
  const result = mainApiEnvironmentSchema.safeParse({
    ...base,
    ...hostedStripe,
    NODE_ENV: "development",
    DATABASE_URL: "postgres://kanera:kanera@db.example.com:5432/kanera",
    KANERA_DEPLOYMENT_MODE: "hosted",
  });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues.some((issue) => issue.path[0] === "KANERA_HOSTED_MODE_TOKEN"), true);
});

void test("development hosted main API requires token when Redis is not local", () => {
  const result = mainApiEnvironmentSchema.safeParse({
    ...base,
    ...hostedStripe,
    NODE_ENV: "development",
    REDIS_URL: "redis://redis.example.com:6379/0",
    KANERA_DEPLOYMENT_MODE: "hosted",
  });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues.some((issue) => issue.path[0] === "KANERA_HOSTED_MODE_TOKEN"), true);
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

void test("production requires a secrets encryption key distinct from the JWT secret", () => {
  const { SECRETS_ENCRYPTION_KEY: _omitted, ...withoutSecretsKey } = base;
  for (const input of [withoutSecretsKey, { ...base, SECRETS_ENCRYPTION_KEY: base.JWT_SECRET }]) {
    const result = environmentResult({ ...input, NODE_ENV: "production" });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.issues.some((issue) => issue.path[0] === "SECRETS_ENCRYPTION_KEY"), true);
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
