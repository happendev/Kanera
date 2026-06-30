import sharp from "sharp";

const THUMBNAIL_WIDTH = 200;
const COVER_WIDTH = 1200;
const JPEG_QUALITY = 80;

const PROCESSABLE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function isProcessableImage(mimeType: string): boolean {
  return PROCESSABLE_MIMES.has(mimeType);
}

export async function generateThumbnail(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}

export async function generateCoverImage(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize({ width: COVER_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}
