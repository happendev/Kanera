import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { generateCoverImage, generateThumbnail } from "./image.js";

void test("PNG image derivatives remain PNG and preserve alpha", async () => {
  const source = await sharp({
    create: {
      width: 40,
      height: 40,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();

  const thumbnail = await generateThumbnail(source, "image/png");
  const cover = await generateCoverImage(source, "image/png");

  assert.equal(thumbnail.mimeType, "image/png");
  assert.equal(thumbnail.ext, "png");
  assert.equal((await sharp(thumbnail.buffer).metadata()).hasAlpha, true);
  assert.equal(cover.mimeType, "image/png");
  assert.equal(cover.ext, "png");
  assert.equal((await sharp(cover.buffer).metadata()).hasAlpha, true);
});

void test("non-PNG image derivatives stay JPEG", async () => {
  const source = await sharp({
    create: {
      width: 40,
      height: 40,
      channels: 3,
      background: { r: 20, g: 40, b: 60 },
    },
  })
    .jpeg()
    .toBuffer();

  const thumbnail = await generateThumbnail(source, "image/jpeg");

  assert.equal(thumbnail.mimeType, "image/jpeg");
  assert.equal(thumbnail.ext, "jpg");
  assert.equal((await sharp(thumbnail.buffer).metadata()).format, "jpeg");
});
