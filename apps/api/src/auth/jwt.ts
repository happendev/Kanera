import crypto from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { refreshTokens } from "@kanera/shared/schema";
import { db } from "../db.js";
import { env } from "../env.js";

const REFRESH_BYTES = 48;
export const REFRESH_REUSE_GRACE_MS = 30_000;

type RefreshRotationResult =
  | { status: "rotated"; userId: string; fresh: { raw: string; hash: string; expiresAt: Date } }
  | { status: "grace"; userId: string }
  | { status: "reused"; userId: string }
  | { status: "invalid" };

export function newRefreshToken(): { raw: string; hash: string; expiresAt: Date } {
  const raw = crypto.randomBytes(REFRESH_BYTES).toString("base64url");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 86_400_000);
  return { raw, hash, expiresAt };
}

export function hashRefresh(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function rotateRefresh(oldRaw: string): Promise<RefreshRotationResult> {
  const oldHash = hashRefresh(oldRaw);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, oldHash))
      .limit(1);

    if (!existing) {
      return { status: "invalid" };
    }

    if (existing.revokedAt) {
      if (existing.replacedById) {
        const graceExpiresAt = new Date(existing.revokedAt.getTime() + REFRESH_REUSE_GRACE_MS);
        if (graceExpiresAt > new Date()) {
          const [replacement] = await tx
            .select({ id: refreshTokens.id })
            .from(refreshTokens)
            .where(and(
              eq(refreshTokens.id, existing.replacedById),
              eq(refreshTokens.userId, existing.userId),
              isNull(refreshTokens.revokedAt),
              gt(refreshTokens.expiresAt, new Date()),
            ))
            .limit(1);
          // A restored tab or reconnecting socket can race a normal refresh with the same cookie.
          // During a tiny window, accept that old token without rotating again so we do not revoke
          // the brand-new session that the first request just established.
          if (replacement) return { status: "grace", userId: existing.userId };
        }

        await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(refreshTokens.userId, existing.userId), isNull(refreshTokens.revokedAt)));
        return { status: "reused", userId: existing.userId };
      }

      return { status: "invalid" };
    }

    if (existing.expiresAt < new Date()) {
      return { status: "invalid" };
    }

    const fresh = newRefreshToken();
    const [inserted] = await tx
      .insert(refreshTokens)
      .values({ userId: existing.userId, tokenHash: fresh.hash, expiresAt: fresh.expiresAt })
      .returning({ id: refreshTokens.id });

    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date(), replacedById: inserted!.id })
      .where(eq(refreshTokens.id, existing.id));

    return { status: "rotated", userId: existing.userId, fresh };
  });
}
