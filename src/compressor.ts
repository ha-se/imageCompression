import sharp from "sharp";
import type { CompressResult } from "./types.js";

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".heif",
  ".webp",
  ".avif",
  ".tiff",
  ".tif",
]);

const QUALITY_STEPS = [80, 60, 40];
const RESIZE_STEPS = [3000, 2000, 1500];

export function isImageFile(fileName: string): boolean {
  const ext = fileName.toLowerCase().replace(/^.*(\.[^.]+)$/, "$1");
  return IMAGE_EXTENSIONS.has(ext);
}

export function toJpegName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, ".jpg");
}

export async function compressToBuffer(
  buffer: Buffer,
  fileName: string,
  maxSizeBytes: number,
  startQuality: number
): Promise<{ data: Buffer; result: CompressResult } | null> {
  const originalSize = buffer.length;

  if (originalSize <= maxSizeBytes || !isImageFile(fileName)) {
    return null;
  }

  let data: Buffer | undefined;

  // Phase 1: quality reduction only
  for (const quality of QUALITY_STEPS) {
    if (quality > startQuality) continue;
    data = await sharp(buffer).jpeg({ quality }).toBuffer();
    if (data.length <= maxSizeBytes) {
      return makeResult(data, originalSize, fileName);
    }
  }

  // Phase 2: resize + lowest quality
  const metadata = await sharp(buffer).metadata();
  const longestSide = Math.max(metadata.width ?? 0, metadata.height ?? 0);

  for (const maxDimension of RESIZE_STEPS) {
    if (longestSide <= maxDimension) continue;

    const resizeOpts =
      (metadata.width ?? 0) >= (metadata.height ?? 0)
        ? { width: maxDimension }
        : { height: maxDimension };

    data = await sharp(buffer)
      .resize(resizeOpts)
      .jpeg({ quality: QUALITY_STEPS[QUALITY_STEPS.length - 1] })
      .toBuffer();

    if (data.length <= maxSizeBytes) {
      return makeResult(data, originalSize, fileName);
    }
  }

  // Best effort: return whatever we got
  if (data) {
    return makeResult(data, originalSize, fileName);
  }

  return null;
}

function makeResult(
  data: Buffer,
  originalSize: number,
  fileName: string
): { data: Buffer; result: CompressResult } {
  return {
    data,
    result: {
      originalSize,
      compressedSize: data.length,
      originalName: fileName,
      newName: toJpegName(fileName),
    },
  };
}
