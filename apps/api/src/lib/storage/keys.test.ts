import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachmentCoverStorageKey,
  attachmentThumbnailStorageKey,
  avatarStorageKey,
  cardAttachmentStorageKey,
  noteAttachmentStorageKey,
  orgLogoStorageKey,
  storageProbeKey,
} from "./keys.js";

void test("upload storage keys are nested under purpose-specific directories", () => {
  assert.match(
    avatarStorageKey("user/../bad id", ".JPG"),
    /^avatars\/user_.._bad_id\/[0-9a-f-]{36}\.jpg$/,
  );
  assert.match(cardAttachmentStorageKey("card/../bad id", ".PDF"), /^cards\/card_.._bad_id\/[0-9a-f-]{36}\.pdf$/);
  assert.match(noteAttachmentStorageKey("note/../bad id", "txt"), /^notes\/note_.._bad_id\/[0-9a-f-]{36}\.txt$/);
  assert.match(orgLogoStorageKey("Png"), /^org\/logo\/[0-9a-f-]{36}\.png$/);
  assert.match(storageProbeKey(), /^system\/storage-tests\/[0-9a-f-]{36}\.txt$/);
});

void test("upload storage keys never include the client id prefix", () => {
  const key = avatarStorageKey("client-1/user-1", "webp");

  assert.equal(key.startsWith("client-1/"), false);
  assert.equal(key.includes("//"), false);
});

void test("attachment derivatives stay beside the original attachment", () => {
  assert.equal(attachmentThumbnailStorageKey("cards/card-1/file.png"), "cards/card-1/file_thumb.jpg");
  assert.equal(attachmentCoverStorageKey("cards/card-1/file.png"), "cards/card-1/file_cover.jpg");
  assert.equal(attachmentThumbnailStorageKey("cards/card-1/file"), "cards/card-1/file_thumb.jpg");
});
