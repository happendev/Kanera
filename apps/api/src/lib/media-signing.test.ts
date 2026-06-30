import assert from "node:assert/strict";
import { mock, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://kanera_test:kanera_test@localhost:55433/kanera_test";
process.env.JWT_SECRET = "test-jwt-secret-with-enough-length";
process.env.MEDIA_SIGNING_SECRET = "test-media-secret-with-at-least-thirty-two-chars";
process.env.API_PUBLIC_URL = "http://api.test";
process.env.WEB_ORIGIN = "http://web.test";

void test("signMediaUrl creates a verifiable stable bucketed URL", async () => {
  const { signMediaUrl, verifyMediaToken } = await import("./media-signing.js");

  const clock = mock.method(Date, "now", () => 1_700_000_001_000);
  try {
    const first = signMediaUrl({ clientId: "client-1", key: "cards/card-1/image.jpg", ttlMs: 60_000 });
    mock.method(Date, "now", () => 1_700_000_030_000);
    const second = signMediaUrl({ clientId: "client-1", key: "cards/card-1/image.jpg", ttlMs: 60_000 });

    assert.equal(first, second);

    const url = new URL(first);
    assert.equal(url.origin, "http://api.test");
    assert.equal(url.pathname, "/api/media/client-1/cards/card-1/image.jpg");
    assert.equal(verifyMediaToken({
      clientId: "client-1",
      key: "cards/card-1/image.jpg",
      t: url.searchParams.get("t")!,
      e: url.searchParams.get("e")!,
    }), true);
  } finally {
    clock.mock.restore();
  }
});

void test("verifyMediaToken rejects tampering and expiry", async () => {
  const { signMediaUrl, verifyMediaToken } = await import("./media-signing.js");

  const clock = mock.method(Date, "now", () => 1_000);
  try {
    const url = new URL(signMediaUrl({ clientId: "client-1", key: "cards/card-1/image.jpg", ttlMs: 60_000 }));
    const t = url.searchParams.get("t")!;
    const e = url.searchParams.get("e")!;

    assert.equal(verifyMediaToken({ clientId: "client-2", key: "cards/card-1/image.jpg", t, e }), false);
    assert.equal(verifyMediaToken({ clientId: "client-1", key: "cards/card-2/image.jpg", t, e }), false);
    assert.equal(verifyMediaToken({ clientId: "client-1", key: "cards/card-1/image.jpg", t: `${t.slice(0, -1)}x`, e }), false);
    assert.equal(verifyMediaToken({ clientId: "client-1", key: "cards/card-1/image.jpg", t, e: String(Number(e) + 60_000) }), false);

    clock.mock.mockImplementation(() => Number(e) + 1);
    assert.equal(verifyMediaToken({ clientId: "client-1", key: "cards/card-1/image.jpg", t, e }), false);
  } finally {
    clock.mock.restore();
  }
});

void test("media tokens default to session lifetime and require explicit share kind for long-lived URLs", async () => {
  const { mediaCacheMaxAge, signMediaUrl, verifyMediaToken } = await import("./media-signing.js");

  const DEFAULT_TTL_MS = 10 * 24 * 60 * 60 * 1000;
  const clock = mock.method(Date, "now", () => 900_001);
  try {
    const sessionUrl = new URL(signMediaUrl({ clientId: "client-1", key: "cards/card-1/image.jpg" }));
    const shareUrl = new URL(signMediaUrl({ clientId: "client-1", key: "cards/card-1/image.jpg", kind: "share" }));
    // floor()+2 bucket: a freshly minted session URL is valid for at least one
    // full TTL window and at most two.
    const sessionMaxAge = (Math.floor(Date.now() / DEFAULT_TTL_MS) + 2) * DEFAULT_TTL_MS - Date.now();

    assert.equal(sessionUrl.searchParams.get("s"), null);
    assert.equal(Number(sessionUrl.searchParams.get("e")) - Date.now(), sessionMaxAge);
    // The cache max-age clamps to one TTL window even though the URL itself stays
    // valid for up to two — the Cache-Control window matches the rotation window.
    assert.equal(mediaCacheMaxAge(sessionUrl.searchParams.get("e")!), Math.min(DEFAULT_TTL_MS, sessionMaxAge));

    assert.equal(shareUrl.searchParams.get("s"), "share");
    assert.equal(verifyMediaToken({
      clientId: "client-1",
      key: "cards/card-1/image.jpg",
      t: shareUrl.searchParams.get("t")!,
      e: shareUrl.searchParams.get("e")!,
      s: "share",
    }), true);
    assert.equal(verifyMediaToken({
      clientId: "client-1",
      key: "cards/card-1/image.jpg",
      t: shareUrl.searchParams.get("t")!,
      e: shareUrl.searchParams.get("e")!,
    }), false);
  } finally {
    clock.mock.restore();
  }
});

void test("freshly minted session URL never expires sooner than a full TTL window", async () => {
  const { signMediaUrl } = await import("./media-signing.js");
  const DEFAULT_TTL_MS = 10 * 24 * 60 * 60 * 1000;

  // Sample across a window, including right before a boundary — the failure mode
  // that produced near-zero lifetimes (mass 404s 2026-06-26) under Math.ceil.
  const base = Math.floor(1_700_000_000_000 / DEFAULT_TTL_MS) * DEFAULT_TTL_MS;
  for (const now of [base + 1, base + DEFAULT_TTL_MS / 2, base + DEFAULT_TTL_MS - 1]) {
    const clock = mock.method(Date, "now", () => now);
    try {
      const url = new URL(signMediaUrl({ clientId: "client-1", key: "cards/card-1/image.jpg" }));
      const lifetime = Number(url.searchParams.get("e")) - now;
      assert.ok(lifetime >= DEFAULT_TTL_MS, `expected lifetime >= ${DEFAULT_TTL_MS}, got ${lifetime} at now=${now}`);
      assert.ok(lifetime <= 2 * DEFAULT_TTL_MS, `expected lifetime <= ${2 * DEFAULT_TTL_MS}, got ${lifetime} at now=${now}`);
    } finally {
      clock.mock.restore();
    }
  }
});

void test("a URL minted in the previous window is still valid after the window rolls", async () => {
  const { signMediaUrl, verifyMediaToken } = await import("./media-signing.js");
  const DEFAULT_TTL_MS = 10 * 24 * 60 * 60 * 1000;
  const boundary = Math.floor(1_700_000_000_000 / DEFAULT_TTL_MS) * DEFAULT_TTL_MS;

  const minted = mock.method(Date, "now", () => boundary - 1);
  let url: URL;
  try {
    url = new URL(signMediaUrl({ clientId: "client-1", key: "cards/card-1/image.jpg" }));
  } finally {
    minted.mock.restore();
  }

  // Roll one whole window forward: the previously cached URL must still verify so
  // the new window's URL never strands the old one mid-rollover (the overlap).
  const rolled = mock.method(Date, "now", () => boundary + DEFAULT_TTL_MS);
  try {
    assert.equal(verifyMediaToken({
      clientId: "client-1",
      key: "cards/card-1/image.jpg",
      t: url.searchParams.get("t")!,
      e: url.searchParams.get("e")!,
    }), true);
  } finally {
    rolled.mock.restore();
  }
});

void test("mediaPathFor encodes client ids and nested key segments", async () => {
  const { mediaPathFor } = await import("./media-signing.js");

  assert.equal(
    mediaPathFor("client id", "cards/card id/image 1.jpg"),
    "/api/media/client%20id/cards/card%20id/image%201.jpg",
  );
});
