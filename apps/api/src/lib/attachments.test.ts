import assert from "node:assert/strict";
import { test } from "node:test";
import { getAllowedAttachmentExtension } from "@kanera/shared/attachments";

void test("attachment allowlist accepts mp4 video and common audio files", () => {
  assert.equal(getAllowedAttachmentExtension("video/mp4", "demo.mp4"), "mp4");
  assert.equal(getAllowedAttachmentExtension("audio/mpeg", "voice-note.mp3"), "mp3");
  assert.equal(getAllowedAttachmentExtension("audio/wav", "clip.wav"), "wav");
  assert.equal(getAllowedAttachmentExtension("audio/mp4", "meeting.m4a"), "m4a");
});

void test("attachment allowlist accepts email message files by MIME type and extension", () => {
  assert.equal(getAllowedAttachmentExtension("message/rfc822", "message.eml"), "eml");
  assert.equal(getAllowedAttachmentExtension("application/octet-stream", "message.eml"), "eml");
});
