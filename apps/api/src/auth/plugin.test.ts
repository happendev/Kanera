import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import "../test/setup.js";
import { trackTestServer } from "../test/server.js";

async function buildAuthPluginTestServer() {
  const [{ default: authPlugin }, { registerErrorHandler }] = await Promise.all([
    import("./plugin.js"),
    import("../lib/errors.js"),
  ]);
  const app = trackTestServer(Fastify({ logger: false }));
  await app.register(authPlugin);
  registerErrorHandler(app);
  app.get("/protected", { preHandler: app.authenticate }, async (req) => ({ auth: req.auth }));
  return app;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwtWithSecret(payload: Record<string, unknown>, secret: string): string {
  const encodedHeader = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const encodedPayload = base64UrlJson(payload);
  const signature = crypto.createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

void test("protected routes reject malformed bearer tokens", async () => {
  const app = await buildAuthPluginTestServer();

  const response = await app.inject({
    method: "GET",
    url: "/protected",
    headers: { authorization: "Bearer not-a-jwt" },
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { code: "UNAUTHORIZED", message: "unauthorized" });
});

void test("protected routes reject JWTs signed with the wrong secret", async () => {
  const app = await buildAuthPluginTestServer();
  const wrongSecretToken = signJwtWithSecret(
    { sub: "user-1", cid: "client-1", role: "member" },
    "wrong-secret-with-enough-length",
  );

  const response = await app.inject({
    method: "GET",
    url: "/protected",
    headers: { authorization: `Bearer ${wrongSecretToken}` },
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { code: "UNAUTHORIZED", message: "unauthorized" });
});

void test("protected routes expose valid JWT claims on req.auth", async () => {
  const app = await buildAuthPluginTestServer();
  const token = app.jwt.sign({ sub: "user-1", cid: "client-1", role: "admin" });

  const response = await app.inject({
    method: "GET",
    url: "/protected",
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(response.statusCode, 200);
  const { auth } = response.json();
  assert.equal(auth.sub, "user-1");
  assert.equal(auth.cid, "client-1");
  assert.equal(auth.role, "admin");
  assert.equal(typeof auth.iat, "number");
  assert.equal(typeof auth.exp, "number");
});
