import assert from "node:assert/strict";
import test from "node:test";
import { mediaContentTypeForKey } from "./routes.js";

void test("mediaContentTypeForKey serves MP4 attachments as browser-playable video", () => {
  assert.equal(mediaContentTypeForKey("cards/card-1/walkthrough.mp4"), "video/mp4");
  assert.equal(mediaContentTypeForKey("cards/card-1/WALKTHROUGH.MP4"), "video/mp4");
});

void test("mediaContentTypeForKey keeps unknown attachments download-only", () => {
  assert.equal(mediaContentTypeForKey("cards/card-1/archive.bin"), "application/octet-stream");
});
