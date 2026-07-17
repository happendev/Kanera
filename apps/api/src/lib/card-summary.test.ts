import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://kanera_test:kanera_test@localhost:55433/kanera_test";
process.env.JWT_SECRET = "test-jwt-secret-with-enough-length";
process.env.MEDIA_SIGNING_SECRET = "test-media-secret-with-at-least-thirty-two-chars";
process.env.API_PUBLIC_URL = "http://api.test";
process.env.WEB_ORIGIN = "http://web.test";

void test("card summaries prefer generated PNG thumbnails so transparency survives first render", async () => {
  const { toWireCardSummary } = await import("./card-summary.js");
  const summary = toWireCardSummary({
    id: "card-1",
    listId: "list-1",
    boardId: "board-1",
    title: "Transparent cover",
    position: "1000.0000000000",
    dueDateLocalDate: null,
    dueDateSlot: null,
    dueDateTimezone: null,
    completedAt: null,
    archivedAt: null,
    coverAttachmentId: "attachment-1",
    createdAt: new Date("2026-07-06T00:00:00.000Z"),
    updatedAt: new Date("2026-07-06T00:00:00.000Z"),
    hasDescription: false,
    commentCount: 0,
    attachmentCount: 1,
    checklistDoneCount: 0,
    checklistTotalCount: 0,
    labelIds: [],
    assigneeIds: [],
    customFieldValues: [],
    coverFileKey: "cards/card-1/cover.png",
    coverUrl: "/api/media/client-1/cards/card-1/cover.png",
    coverMimeType: "image/png",
    coverThumbnailFileKey: "cards/card-1/cover-thumb.png",
    coverThumbnailUrl: "/api/media/client-1/cards/card-1/cover-thumb.png",
    coverImageFileKey: "cards/card-1/cover-small.png",
    coverImageUrl: "/api/media/client-1/cards/card-1/cover-small.png",
    coverImageWidth: 1200,
    coverImageHeight: 600,
    coverImageColor: "#123456",
  }, "client-1");

  assert.match(new URL(summary.coverUrl!).pathname, /\/cover-thumb\.png$/);
  assert.deepEqual([summary.coverImageWidth, summary.coverImageHeight, summary.coverImageColor], [1200, 600, "#123456"]);
});

void test("card summaries prefer generated JPEG thumbnails for non-PNG images", async () => {
  const { toWireCardSummary } = await import("./card-summary.js");
  const summary = toWireCardSummary({
    id: "card-1",
    listId: "list-1",
    boardId: "board-1",
    title: "Photo cover",
    position: "1000.0000000000",
    dueDateLocalDate: null,
    dueDateSlot: null,
    dueDateTimezone: null,
    completedAt: null,
    archivedAt: null,
    coverAttachmentId: "attachment-1",
    createdAt: new Date("2026-07-06T00:00:00.000Z"),
    updatedAt: new Date("2026-07-06T00:00:00.000Z"),
    hasDescription: false,
    commentCount: 0,
    attachmentCount: 1,
    checklistDoneCount: 0,
    checklistTotalCount: 0,
    labelIds: [],
    assigneeIds: [],
    customFieldValues: [],
    coverFileKey: "cards/card-1/cover.jpg",
    coverUrl: "/api/media/client-1/cards/card-1/cover.jpg",
    coverMimeType: "image/jpeg",
    coverThumbnailFileKey: "cards/card-1/cover-thumb.jpg",
    coverThumbnailUrl: "/api/media/client-1/cards/card-1/cover-thumb.jpg",
    coverImageFileKey: "cards/card-1/cover-small.jpg",
    coverImageUrl: "/api/media/client-1/cards/card-1/cover-small.jpg",
    coverImageWidth: null,
    coverImageHeight: null,
    coverImageColor: null,
  }, "client-1");

  assert.match(new URL(summary.coverUrl!).pathname, /\/cover-thumb\.jpg$/);
  assert.deepEqual([summary.coverImageWidth, summary.coverImageHeight, summary.coverImageColor], [null, null, null]);
});
