import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { generateCoverImage, generateThumbnail } from "./image.js";

function rgb(hex: string | null): [number, number, number] {
  assert.match(hex ?? "", /^#[0-9a-f]{6}$/);
  return [Number.parseInt(hex!.slice(1, 3), 16), Number.parseInt(hex!.slice(3, 5), 16), Number.parseInt(hex!.slice(5, 7), 16)];
}

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
  assert.deepEqual([thumbnail.width, thumbnail.height], [40, 40]);
  assert.equal((await sharp(thumbnail.buffer).metadata()).hasAlpha, true);
  assert.equal(thumbnail.dominantColor, null);
  assert.equal(cover.mimeType, "image/png");
  assert.equal(cover.ext, "png");
  assert.deepEqual([cover.width, cover.height], [40, 40]);
  assert.equal((await sharp(cover.buffer).metadata()).hasAlpha, true);
});

void test("JPEG large and thumbnail derivatives are re-encoded as JPEG", async () => {
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
  const cover = await generateCoverImage(source, "image/jpeg");

  assert.equal(thumbnail.mimeType, "image/jpeg");
  assert.equal(thumbnail.ext, "jpg");
  assert.equal((await sharp(thumbnail.buffer).metadata()).format, "jpeg");
  assert.equal(cover.mimeType, "image/jpeg");
  assert.equal(cover.ext, "jpg");
  assert.equal((await sharp(cover.buffer).metadata()).format, "jpeg");
  const [red, green, blue] = rgb(thumbnail.dominantColor);
  assert.ok(Math.abs(red - 20) <= 4 && Math.abs(green - 40) <= 4 && Math.abs(blue - 60) <= 4);
});

void test("animated GIF thumbnails use only the first frame and become JPEG", async () => {
  const source = Buffer.from(
    "R0lGODlhAgACAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAAAAAACH/C0ltYWdlTWFnaWNrDmdhbW1hPTAuNDU0NTQ1ACwAAAAAAgACAAACAoRRACH5BAAKAAAAIf8LSW1hZ2VNYWdpY2sOZ2FtbWE9MC40NTQ1NDUALAAAAAACAAIAgAAA/wAAAAIChFEAOw==",
    "base64",
  );

  const thumbnail = await generateThumbnail(source, "image/gif");
  const sourceMetadata = await sharp(source, { animated: true }).metadata();
  const metadata = await sharp(thumbnail.buffer).metadata();
  const { dominant } = await sharp(thumbnail.buffer).stats();

  assert.equal(sourceMetadata.pages, 2);
  assert.equal(thumbnail.mimeType, "image/jpeg");
  assert.equal(thumbnail.ext, "jpg");
  assert.equal(metadata.pages ?? 1, 1);
  assert.ok(dominant.r > dominant.b, "the red first frame should be selected instead of the blue second frame");
  const [red, , blue] = rgb(thumbnail.dominantColor);
  assert.ok(red > blue, "the stored colour should also come from the red first-frame thumbnail");
});

void test("cover generation reports the resized derivative dimensions", async () => {
  const source = await sharp({
    create: {
      width: 2400,
      height: 800,
      channels: 3,
      background: { r: 20, g: 40, b: 60 },
    },
  }).jpeg().toBuffer();

  const cover = await generateCoverImage(source, "image/jpeg");

  assert.deepEqual([cover.width, cover.height], [1200, 400]);
});

void test("transparent PNG thumbnail colours ignore invisible pixels", async () => {
  const redSquare = await sharp({
    create: { width: 20, height: 20, channels: 4, background: { r: 230, g: 30, b: 40, alpha: 1 } },
  }).png().toBuffer();
  const source = await sharp({
    create: {
      width: 40,
      height: 40,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: redSquare, left: 10, top: 10 }]).png().toBuffer();

  const thumbnail = await generateThumbnail(source, "image/png");
  const [red, green, blue] = rgb(thumbnail.dominantColor);

  assert.ok(red > 200 && green < 60 && blue < 70);
});

void test("WebP thumbnail colours are calculated after conversion to the final JPEG", async () => {
  const source = await sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 25, g: 180, b: 75 } },
  }).webp().toBuffer();

  const thumbnail = await generateThumbnail(source, "image/webp");
  const [red, green, blue] = rgb(thumbnail.dominantColor);

  assert.equal(thumbnail.mimeType, "image/jpeg");
  assert.ok(green > red && green > blue);
});
