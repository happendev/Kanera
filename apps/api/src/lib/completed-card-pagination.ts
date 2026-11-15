import { dto } from "@kanera/shared";
import { badRequest } from "./errors.js";

export interface CompletedCardsCursor {
  completedAt: Date;
  id: string;
}

export function encodeCompletedCardsCursor(card: { completedAt: Date | string | null; id: string }): string | null {
  if (!card.completedAt) return null;
  return Buffer.from(JSON.stringify({ completedAt: new Date(card.completedAt).toISOString(), id: card.id }), "utf8").toString("base64url");
}

export function decodeCompletedCardsCursor(cursor: string | undefined): CompletedCardsCursor | null {
  if (!cursor) return null;
  try {
    const parsed = dto.completedCardsCursor.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    const completedAt = new Date(parsed.completedAt);
    return { completedAt, id: parsed.id };
  } catch {
    throw badRequest("invalid completed cards cursor");
  }
}
