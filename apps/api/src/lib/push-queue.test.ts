import assert from "node:assert/strict";
import { test } from "node:test";
import { toPushQueuePayload } from "./push-queue.js";

void test("browser push payload keeps Angular's nested notification and deep-link contract", () => {
  assert.deepEqual(toPushQueuePayload({
    kind: "comment_mentioned",
    title: "Mentioned in a comment",
    body: "Alex mentioned you in Launch / Prepare release",
    url: "/b/launch?card=card-id",
  }), {
    notification: {
      title: "Mentioned in a comment",
      body: "Alex mentioned you in Launch / Prepare release",
      icon: "/assets/favicon/android-chrome-192x192.png",
      badge: "/assets/favicon/notification-badge.png",
      tag: "kanera:notifications:comment_mentioned",
      renotify: true,
      data: {
        kind: "comment_mentioned",
        onActionClick: {
          default: {
            operation: "navigateLastFocusedOrOpen",
            url: "/b/launch?card=card-id",
          },
        },
      },
    },
  });
});

void test("browser push payload replaces only matching activity instead of the entire inbox", () => {
  const tagged = toPushQueuePayload({
    kind: "watching",
    title: "Card updated",
    body: "Alex updated Prepare release",
    tag: "card:card-id:watching",
  });
  const untagged = toPushQueuePayload({
    kind: "watching",
    title: "Card updated",
    body: "Alex updated Prepare release",
  });

  assert.equal(tagged.notification.tag, "card:card-id:watching");
  assert.equal(tagged.notification.renotify, true);
  assert.equal(untagged.notification.tag, "kanera:notifications:watching");
  assert.equal(untagged.notification.renotify, true);
});

void test("browser push payload caps long bodies at 240 characters and preserves short bodies", () => {
  const shortBody = "Alex assigned you to Prepare release";
  const longBody = "x".repeat(241);

  assert.equal(toPushQueuePayload({ kind: "assigned", title: "Card assigned", body: shortBody }).notification.body, shortBody);
  assert.equal(
    toPushQueuePayload({ kind: "assigned", title: "Card assigned", body: longBody }).notification.body,
    `${"x".repeat(239)}…`,
  );
});
