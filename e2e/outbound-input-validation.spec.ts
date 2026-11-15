import { execFileSync } from "node:child_process";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { expect, test } from "./support/fixtures";

function keys() {
  return { p256dh: createECDH("prime256v1").generateKeys().toString("base64url"), auth: randomBytes(16).toString("base64url") };
}

function storedEndpoints(userId: string): string[] {
  expect(userId).toMatch(/^[0-9a-f-]{36}$/);
  const result = execFileSync("docker", ["compose", "-p", "kanera-e2e", "-f", path.join(__dirname, "../docker-compose.e2e.yml"), "exec", "-T", "postgres", "psql", "-U", "kanera_test", "-d", "kanera_test_e2e", "-At", "-v", "ON_ERROR_STOP=1", "-c", `select coalesce(json_agg(endpoint order by endpoint), '[]') from push_subscription where user_id='${userId}'`], { encoding: "utf8", timeout: 10_000 });
  return JSON.parse(result.trim()) as string[];
}

test("direct push registration rejects unsafe destinations and invalid cryptographic material before storing anything", async ({ apiAs }) => {
  const api = await apiAs("amelia");
  const me = await (await api.get("/api/me")).json() as { id: string };
  // These settings belong to the fixture organisation. Enabling its own push
  // creates the test deployment's VAPID configuration without a production service.
  expect((await api.patch("/api/clients/me", { data: { pushEnabled: false } })).status()).toBe(200);
  expect((await api.patch("/api/clients/me", { data: { pushEnabled: true } })).status()).toBe(200);
  const subscription = { endpoint: `https://8.8.8.8/${randomUUID()}`, keys: keys() };
  expect((await api.put("/api/notifications/push/subscription", { data: subscription })).status()).toBe(204);
  try {
    const unsafe = [
      { endpoint: "https://169.254.169.254/latest/meta-data/" },
      { endpoint: "https://[::ffff:a9fe:a9fe]/latest/meta-data/" },
      { endpoint: "http://push.example.test/subscription" },
      { endpoint: "https://user:password@push.example.test/subscription" },
      { endpoint: "https://push.example.test/subscription#fragment" },
      { expirationTime: -1 },
      { expirationTime: 8_640_000_000_000_001 },
      { contentEncoding: "unsafe-encoding" },
      { keys: { ...subscription.keys, auth: "short" } },
      { keys: { ...subscription.keys, p256dh: `B${"A".repeat(86)}` } },
    ];
    for (const change of unsafe) {
      const response = await api.put("/api/notifications/push/subscription", { data: { ...subscription, ...change } });
      expect(response.status(), await response.text()).toBe(400);
      expect(storedEndpoints(me.id)).toEqual([subscription.endpoint]);
    }
    // Service workers rotate subscriptions through this unauthenticated endpoint.
    // Possession of the old capability must not bypass destination validation.
    const rotated = await api.post("/api/notifications/push/subscription-refresh", { data: {
      oldEndpoint: subscription.endpoint, oldAuth: subscription.keys.auth,
      endpoint: "https://169.254.169.254/latest/meta-data/", keys: keys(),
    } });
    expect(rotated.status(), await rotated.text()).toBe(400);
    expect(storedEndpoints(me.id)).toEqual([subscription.endpoint]);
    const outsider = await apiAs("maya");
    const outsiderMe = await (await outsider.get("/api/me")).json() as { id: string };
    const stolen = await outsider.put("/api/notifications/push/subscription", { data: { endpoint: subscription.endpoint, keys: keys() } });
    expect(stolen.status(), await stolen.text()).toBe(404);
    expect(storedEndpoints(me.id)).toEqual([subscription.endpoint]);
    expect(storedEndpoints(outsiderMe.id)).toEqual([]);
    // A legitimate shared-browser account switch proves the existing keypair.
    expect((await outsider.put("/api/notifications/push/subscription", { data: subscription })).status()).toBe(204);
    expect(storedEndpoints(me.id)).toEqual([]);
    expect(storedEndpoints(outsiderMe.id)).toEqual([subscription.endpoint]);
    expect((await api.put("/api/notifications/push/subscription", { data: subscription })).status()).toBe(204);
    const occupied = { endpoint: `https://8.8.8.8/${randomUUID()}`, keys: keys() };
    expect((await api.put("/api/notifications/push/subscription", { data: occupied })).status()).toBe(204);
    try {
      const collision = await api.post("/api/notifications/push/subscription-refresh", { data: {
        oldEndpoint: subscription.endpoint, oldAuth: subscription.keys.auth,
        endpoint: occupied.endpoint, keys: keys(),
      } });
      expect(collision.status(), await collision.text()).toBe(409);
      expect(storedEndpoints(me.id)).toEqual([subscription.endpoint, occupied.endpoint].sort());
    } finally {
      expect((await api.delete("/api/notifications/push/subscription", { data: { endpoint: occupied.endpoint } })).status()).toBe(204);
    }
  } finally {
    expect((await api.delete("/api/notifications/push/subscription", { data: { endpoint: subscription.endpoint } })).status()).toBe(204);
  }
});
