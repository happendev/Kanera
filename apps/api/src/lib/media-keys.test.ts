import assert from "node:assert/strict";
import { mock, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://kanera_test:kanera_test@localhost:55433/kanera_test";
process.env.JWT_SECRET = "test-jwt-secret-with-enough-length";
process.env.MEDIA_SIGNING_SECRET = "test-media-secret-with-at-least-thirty-two-chars";
process.env.API_PUBLIC_URL = "http://api.test";
process.env.WEB_ORIGIN = "http://web.test";

void test("withSignedMedia signs known media fields without touching unrelated values", async () => {
  const { withSignedMedia } = await import("./media-keys.js");
  const clock = mock.method(Date, "now", () => 1_700_000_001_000);
  try {
    const row = withSignedMedia("client-1", {
      id: "row-1",
      avatarUrl: "/api/media/client-1/avatars/user.jpg",
      title: "Keep me",
    });

    assert.equal(row.id, "row-1");
    assert.equal(row.title, "Keep me");
    assert.match(row.avatarUrl, /^http:\/\/api\.test\/api\/media\/client-1\/avatars\/user\.jpg\?t=.+&e=\d+$/);
  } finally {
    clock.mock.restore();
  }
});

void test("signEmbeddedMediaUrls signs HTML and Markdown media references", async () => {
  const { signEmbeddedMediaUrls } = await import("./media-keys.js");
  const clock = mock.method(Date, "now", () => 1_700_000_001_000);
  try {
    const body = [
      '<img src="/api/media/client-1/cards/card-1/image.jpg">',
      "![](/api/media/client-1/cards/card-1/image.jpg)",
      "[file](/api/media/client-1/cards/card-1/file.pdf)",
      '<img src="/api/media/client-2/cards/card-1/other.jpg">',
    ].join("\n");

    const signed = signEmbeddedMediaUrls(body, "client-1")!;

    assert.match(signed, /<img src="http:\/\/api\.test\/api\/media\/client-1\/cards\/card-1\/image\.jpg\?t=.+&e=\d+">/);
    assert.match(signed, /!\[\]\(http:\/\/api\.test\/api\/media\/client-1\/cards\/card-1\/image\.jpg\?t=.+&e=\d+\)/);
    assert.match(signed, /\[file\]\(http:\/\/api\.test\/api\/media\/client-1\/cards\/card-1\/file\.pdf\?t=.+&e=\d+\)/);
    assert.match(signed, /<img src="\/api\/media\/client-2\/cards\/card-1\/other\.jpg">/);
  } finally {
    clock.mock.restore();
  }
});

void test("stripSignedEmbeddedMediaUrls stores embedded media as token-free paths", async () => {
  const { signEmbeddedMediaUrls, stripSignedEmbeddedMediaUrls } = await import("./media-keys.js");
  const clock = mock.method(Date, "now", () => 1_700_000_001_000);
  try {
    const body = [
      '<img src="/api/media/client-1/cards/card-1/image.jpg">',
      "![](/api/media/client-1/cards/card-1/image.jpg)",
      "[file](/api/media/client-1/cards/card-1/file.pdf)",
    ].join("\n");

    const signed = signEmbeddedMediaUrls(body, "client-1")!;
    assert.equal(stripSignedEmbeddedMediaUrls(signed, "client-1"), body);
  } finally {
    clock.mock.restore();
  }
});

void test("storageKeyFromMediaUrl only accepts current media paths for the expected client", async () => {
  const { storageKeyFromMediaUrl } = await import("./media-keys.js");

  assert.equal(storageKeyFromMediaUrl("/api/media/client-1/cards/card-1/image.jpg", "client-1"), "cards/card-1/image.jpg");
  assert.equal(storageKeyFromMediaUrl("http://api.test/api/media/client-1/avatars/user.jpg?t=abc&e=123", "client-1"), "avatars/user.jpg");
  assert.equal(storageKeyFromMediaUrl("/api/media/client-2/cards/card-1/image.jpg", "client-1"), null);
  assert.equal(storageKeyFromMediaUrl("/media/client-1/cards/card-1/image.jpg", "client-1"), null);
  assert.equal(storageKeyFromMediaUrl("http://api.test/uploads/client-1/cards_card-1_image.jpg", "client-1"), null);
});
