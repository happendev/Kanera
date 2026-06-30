import assert from "node:assert/strict";
import test from "node:test";
import { KaneraApiError, KaneraClient } from "./kanera-client.js";

function fetchInputUrl(input: Parameters<typeof fetch>[0]) {
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return input;
}

void test("maps public API auth errors without leaking response bodies", async () => {
  const client = new KaneraClient({
    baseUrl: "https://api.example.test",
    apiKey: "kanera_live_test",
    fetchImpl: async () => new Response(JSON.stringify({ code: "FORBIDDEN", message: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
  });

  await assert.rejects(
    client.get("/api/v1/workspaces"),
    (error) => error instanceof KaneraApiError && error.status === 403 && error.code === "FORBIDDEN",
  );
});

void test("maps non-JSON public API failures to structured errors", async () => {
  const client = new KaneraClient({
    baseUrl: "https://api.example.test",
    apiKey: "kanera_live_test",
    fetchImpl: async () => new Response("<html>bad gateway</html>", {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "content-type": "text/html", "retry-after": "30" },
    }),
  });

  await assert.rejects(
    client.get("/api/v1/workspaces"),
    (error) =>
      error instanceof KaneraApiError
      && error.status === 502
      && error.code === "PUBLIC_API_ERROR"
      && error.message === "Bad Gateway"
      && error.retryAfter === "30",
  );
});

void test("maps empty public API failures to default errors", async () => {
  const client = new KaneraClient({
    baseUrl: "https://api.example.test",
    apiKey: "kanera_live_test",
    fetchImpl: async () => new Response(null, { status: 500, statusText: "" }),
  });

  await assert.rejects(
    client.get("/api/v1/workspaces"),
    (error) =>
      error instanceof KaneraApiError
      && error.status === 500
      && error.code === "PUBLIC_API_ERROR"
      && error.message === "public API request failed",
  );
});

void test("maps invalid successful JSON responses to structured errors", async () => {
  const client = new KaneraClient({
    baseUrl: "https://api.example.test",
    apiKey: "kanera_live_test",
    fetchImpl: async () => new Response("not json", { status: 200 }),
  });

  await assert.rejects(
    client.get("/api/v1/workspaces"),
    (error) =>
      error instanceof KaneraApiError
      && error.status === 200
      && error.code === "INVALID_PUBLIC_API_RESPONSE",
  );
});

void test("appends query params to public API requests", async () => {
  let requestedUrl: string | null = null;
  const client = new KaneraClient({
    baseUrl: "https://api.example.test",
    apiKey: "kanera_live_test",
    fetchImpl: async (input) => {
      requestedUrl = fetchInputUrl(input);
      return new Response(JSON.stringify([]), { status: 200 });
    },
  });

  await client.get("/api/v1/workspaces", { limit: 25, archived: false, skip: null });

  assert.equal(requestedUrl, "https://api.example.test/api/v1/workspaces?limit=25&archived=false");
});
