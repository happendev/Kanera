import assert from "node:assert/strict";
import { test } from "node:test";
import { stripAttachmentReferences } from "./strip-attachment-refs.js";

void test("stripAttachmentReferences escapes attachment URLs before building matchers", () => {
  const url = "https://example.test/media/cards/abc/file(1)+draft?.png";
  const body = [
    `![Preview](${url})`,
    "Keep this nearby URL untouched:",
    "https://example.test/media/cards/abc/fileX1-draftZ.png",
  ].join("\n");

  const result = stripAttachmentReferences(body, url);

  assert.equal(result.changed, true);
  assert.equal(result.body, "\nKeep this nearby URL untouched:\nhttps://example.test/media/cards/abc/fileX1-draftZ.png");
});
