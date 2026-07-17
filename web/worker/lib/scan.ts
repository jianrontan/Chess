/**
 * Image-to-FEN v1 (/api/scan): vision LLM transcribes a board photo into the
 * FEN piece-placement field. The model output is UNTRUSTED — it is validated
 * by chess.js before anything is returned, and the client always shows the
 * result in the board editor for human confirmation (side to move and
 * castling rights cannot come from an image; the user supplies them).
 */

import Anthropic from "@anthropic-ai/sdk";
import { Chess } from "chess.js";

/** Payload caps for /api/scan. */
export const SCAN_CAPS = {
  // ~1.4MB of raw image after base64 overhead; client downscales to 1024px.
  bodyBytes: 2_000_000,
} as const;

type MediaType = "image/png" | "image/jpeg" | "image/webp";

export interface ScanImage {
  mediaType: MediaType;
  base64: string;
}

export type ScanParse =
  | { ok: true; image: ScanImage }
  | { ok: false; error: string };

/** Parse + cap the request body: `{ image: "data:image/png;base64,..." }`. */
export function parseScanRequest(body: unknown): ScanParse {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "body must be an object" };
  }
  const image = (body as Record<string, unknown>).image;
  if (typeof image !== "string") {
    return { ok: false, error: "image must be a data URL string" };
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image);
  if (!match) {
    return { ok: false, error: "image must be a base64 data URL (png, jpeg, or webp)" };
  }
  return {
    ok: true,
    image: { mediaType: match[1] as MediaType, base64: match[2] },
  };
}

const SCAN_SYSTEM = [
  "You transcribe chessboard images into FEN piece placement.",
  "Output ONLY the FEN board field (the part before the side-to-move):",
  "8 ranks separated by '/', from the rank shown at the TOP of the image",
  "to the rank at the bottom, assuming the white pieces play toward the top",
  "unless coordinates in the image show otherwise.",
  "Uppercase = white pieces, lowercase = black, digits = empty squares.",
  "If the image does not clearly show a chessboard, output exactly NOT_A_BOARD.",
  "No commentary, no code fences, nothing but the board field or NOT_A_BOARD.",
].join(" ");

export const SCAN_MAX_TOKENS = 128;

/**
 * Ask the vision model for the board field. Returns the raw text (still
 * untrusted — validate with `boardToFen`). Null when no API key is
 * configured: scanning has no offline fallback worth faking.
 */
export async function scanWithAnthropic(
  apiKey: string,
  model: string,
  image: ScanImage,
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const res = await client.messages.create({
    model,
    max_tokens: SCAN_MAX_TOKENS,
    system: SCAN_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: image.mediaType,
              data: image.base64,
            },
          },
          { type: "text", text: "Transcribe this position." },
        ],
      },
    ],
  });
  const block = res.content[0];
  return block?.type === "text" ? block.text.trim() : "";
}

export type BoardResult =
  | { ok: true; board: string; fen: string }
  | { ok: false; error: string };

/**
 * Validate a model-produced board field by building a full FEN and asking
 * chess.js to accept it. Side to move / castling / ep are placeholders —
 * the client's confirm screen sets the real ones.
 */
export function boardToFen(raw: string): BoardResult {
  const board = raw.trim();
  if (board === "NOT_A_BOARD") {
    return { ok: false, error: "no chessboard was recognized in the image" };
  }
  if (!/^[pnbrqkPNBRQK1-8/]{15,80}$/.test(board) || board.split("/").length !== 8) {
    return { ok: false, error: "the scan produced an unreadable board — try a clearer photo" };
  }
  const fen = `${board} w - - 0 1`;
  try {
    new Chess(fen);
  } catch {
    return { ok: false, error: "the scan produced an illegal position — try a clearer photo" };
  }
  return { ok: true, board, fen };
}
