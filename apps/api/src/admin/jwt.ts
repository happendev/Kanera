import crypto from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { adminRefreshTokens } from "@kanera/shared/schema";
import { db } from "../db.js";
import { env } from "../env.js";

// Deliberate verbatim clone of auth/jwt.ts against admin_refresh_tokens. The rotation + reuse-theft
// logic must stay identical, but the storage table is separate so admin and tenant sessions cannot be
// confused for one another. Keep the two in sync when either changes.
const REFRESH_BYTES = 48;
export const ADMIN_REFRESH_REUSE_GRACE_MS = 30_000;

type AdminRefreshRotationResult =
  | { status: "rotated"; adminUserId: string; fresh: { raw: string; hash: string; expiresAt: Date } }
  | { status: "grace"; adminUserId: string }
  | { status: "reused"; adminUserId: string }
  | { status: "invalid" };

export function newAdminRefreshToken(): { raw: string; hash: string; expiresAt: Date } {
  const raw = crypto.randomBytes(REFRESH_BYTES).toString("base64url");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expiresAt = new Date(Date.now() + env.ADMIN_JWT_REFRESH_TTL_DAYS * 86_400_000);
  return { raw, hash, expiresAt };
}

export function hashAdminRefresh(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function rotateAdminRefresh(oldRaw: string): Promise<AdminRefreshRotationResult> {
  const oldHash = hashAdminRefresh(oldRaw);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(adminRefreshTokens)
      .where(eq(adminRefreshTokens.tokenHash, oldHash))
      .limit(1);

    if (!existing) {
      return { status: "invalid" };
    }

    if (existing.revokedAt) {
      if (existing.replacedById) {
        const graceExpiresAt = new Date(existing.revokedAt.getTime() + ADMIN_REFRESH_REUSE_GRACE_MS);
        if (graceExpiresAt > new Date()) {
          const [replacement] = await tx
            .select({ id: adminRefreshTokens.id })
            .from(adminRefreshTokens)
            .where(and(
              eq(adminRefreshTokens.id, existing.replacedById),
              eq(adminRefreshTokens.adminUserId, existing.adminUserId),
              isNull(adminRefreshTokens.revokedAt),
              gt(adminRefreshTokens.expiresAt, new Date()),
            ))
            .limit(1);
          // A reconnecting tab can race a normal refresh with the same cookie; during a tiny window
          // accept the old token without rotating again so the brand-new session is not revoked.
          if (replacement) return { status: "grace", adminUserId: existing.adminUserId };
        }

        await tx
          .update(adminRefreshTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(adminRefreshTokens.adminUserId, existing.adminUserId), isNull(adminRefreshTokens.revokedAt)));
        return { status: "reused", adminUserId: existing.adminUserId };
      }

      return { status: "invalid" };
    }

    if (existing.expiresAt < new Date()) {
      return { status: "invalid" };
    }

    const fresh = newAdminRefreshToken();
    const [inserted] = await tx
      .insert(adminRefreshTokens)
      .values({ adminUserId: existing.adminUserId, tokenHash: fresh.hash, expiresAt: fresh.expiresAt })
      .returning({ id: adminRefreshTokens.id });

    await tx
      .update(adminRefreshTokens)
      .set({ revokedAt: new Date(), replacedById: inserted!.id })
      .where(eq(adminRefreshTokens.id, existing.id));

    return { status: "rotated", adminUserId: existing.adminUserId, fresh };
  });
}
