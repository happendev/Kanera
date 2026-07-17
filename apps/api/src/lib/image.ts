import sharp from "sharp";

// Board cards are 270px wide. Keep enough pixels for a crisp card cover without loading the
// 1200px detail derivative for every visible card.
const THUMBNAIL_WIDTH = 400;
const COVER_WIDTH = 1200;
const JPEG_QUALITY = 80;

const PROCESSABLE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export type GeneratedImage = {
  buffer: Buffer;
  mimeType: "image/jpeg" | "image/png";
  ext: "jpg" | "png";
  width: number;
  height: number;
};

export type GeneratedThumbnailImage = GeneratedImage & {
  dominantColor: string | null;
};

export function isProcessableImage(mimeType: string): boolean {
  return PROCESSABLE_MIMES.has(mimeType);
}

function hexChannel(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0");
}

export async function dominantColorFromThumbnail(buffer: Buffer): Promise<string | null> {
  const { data } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const buckets = new Map<number, { weight: number; red: number; green: number; blue: number }>();

  // Quantize the final thumbnail pixels into 4-bit RGB buckets, ignore effectively transparent
  // pixels, then average the winning bucket. Alpha-weighting prevents translucent PNG edges from
  // overpowering the visible artwork while JPEG/GIF/WebP thumbnails naturally use full weight.
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3]!;
    if (alpha < 16) continue;
    const red = data[offset]!;
    const green = data[offset + 1]!;
    const blue = data[offset + 2]!;
    const weight = alpha / 255;
    const key = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
    const bucket = buckets.get(key) ?? { weight: 0, red: 0, green: 0, blue: 0 };
    bucket.weight += weight;
    bucket.red += red * weight;
    bucket.green += green * weight;
    bucket.blue += blue * weight;
    buckets.set(key, bucket);
  }

  let primary: { weight: number; red: number; green: number; blue: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!primary || bucket.weight > primary.weight) primary = bucket;
  }
  if (!primary) return null;
  return `#${hexChannel(primary.red / primary.weight)}${hexChannel(primary.green / primary.weight)}${hexChannel(primary.blue / primary.weight)}`;
}

async function generateDerivative(buffer: Buffer, width: number, sourceMimeType: string): Promise<GeneratedImage> {
  // GIF attachments retain their animated original, while derivatives deliberately decode only
  // the first frame. This keeps board thumbnails static and avoids animated-image work on scroll.
  const pipeline = sharp(buffer, sourceMimeType === "image/gif" ? { page: 0, pages: 1 } : undefined)
    .resize({ width, withoutEnlargement: true });

  // Transparent PNG derivatives must keep alpha. JPEGs are re-encoded at 80%; GIF and WebP
  // derivatives become compact JPEGs while their original attachment remains untouched.
  if (sourceMimeType === "image/png") {
    const { data, info } = await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
    return {
      buffer: data,
      mimeType: "image/png",
      ext: "png",
      width: info.width,
      height: info.height,
    };
  }

  const { data, info } = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer({ resolveWithObject: true });
  return {
    buffer: data,
    mimeType: "image/jpeg",
    ext: "jpg",
    width: info.width,
    height: info.height,
  };
}

// Small attachment preview used in attachment lists and inline upload surfaces.
export async function generateThumbnail(buffer: Buffer, sourceMimeType: string): Promise<GeneratedThumbnailImage> {
  const thumbnail = await generateDerivative(buffer, THUMBNAIL_WIDTH, sourceMimeType);
  return { ...thumbnail, dominantColor: await dominantColorFromThumbnail(thumbnail.buffer) };
}

// Wider card-cover derivative used by board tiles and card headers.
export async function generateCoverImage(buffer: Buffer, sourceMimeType: string): Promise<GeneratedImage> {
  return generateDerivative(buffer, COVER_WIDTH, sourceMimeType);
}
