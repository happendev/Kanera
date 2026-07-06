import sharp from "sharp";

const THUMBNAIL_WIDTH = 200;
const COVER_WIDTH = 1200;
const JPEG_QUALITY = 80;

const PROCESSABLE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
export type GeneratedImage = {
  buffer: Buffer;
  mimeType: "image/jpeg" | "image/png";
  ext: "jpg" | "png";
};

export function isProcessableImage(mimeType: string): boolean {
  return PROCESSABLE_MIMES.has(mimeType);
}

async function generateDerivative(buffer: Buffer, width: number, sourceMimeType: string): Promise<GeneratedImage> {
  const pipeline = sharp(buffer)
    .resize({ width, withoutEnlargement: true });

  // Transparent PNG covers must keep alpha; flattening them to JPEG makes the
  // board card/header render transparent pixels as black. Other processable
  // image types use JPEG derivatives to keep attachment previews compact.
  if (sourceMimeType === "image/png") {
    return {
      buffer: await pipeline.png({ compressionLevel: 9 }).toBuffer(),
      mimeType: "image/png",
      ext: "png",
    };
  }

  return {
    buffer: await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer(),
    mimeType: "image/jpeg",
    ext: "jpg",
  };
}

// Small attachment preview used in attachment lists and inline upload surfaces.
export async function generateThumbnail(buffer: Buffer, sourceMimeType: string): Promise<GeneratedImage> {
  return generateDerivative(buffer, THUMBNAIL_WIDTH, sourceMimeType);
}

// Wider card-cover derivative used by board tiles and card headers.
export async function generateCoverImage(buffer: Buffer, sourceMimeType: string): Promise<GeneratedImage> {
  return generateDerivative(buffer, COVER_WIDTH, sourceMimeType);
}
