"use client";

/**
 * Client for /api/scan (image-to-FEN). Downscales the photo in the browser
 * before upload — smaller payload, fewer vision tokens, and the Worker caps
 * the body size anyway. The scanned position is NEVER trusted directly: the
 * caller must show it in the board editor for the user to confirm/fix, and
 * side-to-move + castling always come from the user.
 */

import { extractError, postWithTurnstile } from "@/lib/explain";

/** Longest edge sent to the vision model. */
const MAX_EDGE_PX = 1024;
const JPEG_QUALITY = 0.9;

/** Read + downscale an image file to a JPEG data URL. */
export async function fileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    // JPEG has no alpha — transparent PNG regions would encode as black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
}

export interface ScanResult {
  /** FEN with placeholder side-to-move/castling — for the board editor. */
  fen: string;
}

/** Upload the image and get the transcribed position (or throw with a message). */
export async function scanImage(dataUrl: string): Promise<ScanResult> {
  const res = await postWithTurnstile("/api/scan", JSON.stringify({ image: dataUrl }));
  if (!res.ok) throw new Error(await extractError(res, `scan failed (${res.status})`));
  const data: unknown = await res.json();
  if (
    typeof data !== "object" ||
    data === null ||
    !("fen" in data) ||
    typeof data.fen !== "string"
  ) {
    throw new Error("scan returned an unexpected response");
  }
  return { fen: data.fen };
}
