import { dto } from "@kanera/shared";
import { getAllowedAttachmentExtension, inferAttachmentMimeType } from "@kanera/shared/attachments";
import { cardAttachmentUploadLinks, oauthGrants, users, workspaceApiKeys } from "@kanera/shared/schema";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { applyBearerAuthContext, type AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { assertWriteCapableCredential } from "../../lib/access.js";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { fileTooLargeError } from "../../lib/read-attachment-upload.js";
import { hashOpaqueToken, newOpaqueToken } from "../../lib/tokens.js";
import { attachmentResponse, prepareCardUpload, storeCardAttachment } from "./attachments.routes.js";

// Long enough to find the file and run curl, short enough that a link pasted into a log or a
// transcript is useless soon after.
const UPLOAD_LINK_TTL_MS = 15 * 60_000;
const USED_LINK_RETENTION_MS = 24 * 60 * 60_000;

function uploadUrl(rawToken: string): string {
  // The issuer is the public API's internet-facing origin (OAuth requires it to be), which is where
  // the agent's machine must reach; the API's own listen address may be internal.
  return new URL(`/uploads/${rawToken}`, env.PUBLIC_API_OAUTH_ISSUER).toString();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Mint a single-use upload URL for one card attachment. Every rule the multipart upload enforces
 * (editor access, active card, owned comment, storage room) is checked now so an agent learns early,
 * and again at upload time with the same credential, since either may change within the TTL.
 */
export async function uploadLinkRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/cards/:id/attachments/upload-links", async (req, reply) => {
    assertWriteCapableCredential(req.auth);
    const { id: cardId } = req.params as { id: string };
    const body = dto.createAttachmentUploadLinkBody.parse(req.body ?? {});
    const mimeType = body.mimeType ?? inferAttachmentMimeType(body.fileName);
    if (!mimeType || !getAllowedAttachmentExtension(mimeType, body.fileName)) {
      throw badRequest("unsupported file type; pass a supported mimeType or a file name with a supported extension");
    }
    const target = await prepareCardUpload(req.auth, cardId, body.source, body.commentId ?? null);

    const now = Date.now();
    const expiresAt = new Date(now + UPLOAD_LINK_TTL_MS);
    const { raw, hash } = newOpaqueToken();
    // Opportunistic cleanup keeps the table bounded without another scheduled job; the expiry index
    // makes it a range delete.
    await db.delete(cardAttachmentUploadLinks).where(lt(cardAttachmentUploadLinks.expiresAt, new Date(now - USED_LINK_RETENTION_MS)));
    await db.insert(cardAttachmentUploadLinks).values({
      tokenHash: hash,
      cardId,
      userId: req.auth.sub,
      claims: req.auth as unknown as Record<string, unknown>,
      fileName: body.fileName,
      mimeType,
      source: body.source,
      commentId: body.commentId ?? null,
      maxBytes: target.uploadEntitlements.maxFileBytes,
      expiresAt,
    });

    const url = uploadUrl(raw);
    return reply.status(201).send({
      uploadUrl: url,
      method: "PUT",
      expiresAt: expiresAt.toISOString(),
      maxBytes: target.uploadEntitlements.maxFileBytes,
      fileName: body.fileName,
      mimeType,
      curl: `curl -fsS -T <path-to-file> ${shellQuote(url)}`,
    });
  });
}

/**
 * Whether the credential that minted a link could still authenticate. Revoking a key, a grant, or
 * the user must also kill links already handed out, not only future API calls.
 */
async function credentialStillLive(claims: AuthClaims): Promise<boolean> {
  const [user] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, claims.sub), isNull(users.deletedAt))).limit(1);
  if (!user) return false;
  const grantId = claims.agentGrantId ?? (claims.apiKeyId?.startsWith("oauth_grant_") ? claims.apiKeyId.slice("oauth_grant_".length) : undefined);
  if (grantId) {
    const [grant] = await db.select({ revokedAt: oauthGrants.revokedAt }).from(oauthGrants).where(eq(oauthGrants.id, grantId)).limit(1);
    // A pre-grant OAuth token keys its bucket on a token family rather than a grant; there is no
    // grant row to consult, and the 15-minute link lifetime bounds that case.
    return !grant || grant.revokedAt === null;
  }
  if (claims.authKind === "apiKey" && claims.apiKeyId) {
    const [key] = await db.select({ id: workspaceApiKeys.id }).from(workspaceApiKeys).where(and(eq(workspaceApiKeys.id, claims.apiKeyId), isNull(workspaceApiKeys.revokedAt))).limit(1);
    return Boolean(key);
  }
  return true;
}

/**
 * The link itself is the credential, so this sits outside `/api/v1` and its bearer authentication.
 * The body is the raw file: `curl -T file URL` sends it with whatever Content-Type (often none),
 * so the type recorded when the link was minted is authoritative.
 */
export async function attachmentUploadRoutes(app: FastifyInstance) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: env.ATTACHMENT_MAX_BYTES }, (_req, body, done) => done(null, body));

  app.put("/uploads/:token", { bodyLimit: env.ATTACHMENT_MAX_BYTES }, async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!/^[A-Za-z0-9_-]{20,128}$/u.test(token)) throw notFound();
    // Claim the link before doing any work: single use holds even for concurrent PUTs, and a failed
    // upload burns it (minting another is one call).
    const [link] = await db
      .update(cardAttachmentUploadLinks)
      .set({ usedAt: new Date() })
      .where(and(
        eq(cardAttachmentUploadLinks.tokenHash, hashOpaqueToken(token)),
        isNull(cardAttachmentUploadLinks.usedAt),
        gt(cardAttachmentUploadLinks.expiresAt, new Date()),
      ))
      .returning();
    // One answer for unknown, used, and expired links so a guessed token learns nothing.
    if (!link) throw new AppError(404, "UPLOAD_LINK_INVALID", "upload link is invalid, expired, or already used; create a new one");

    const claims = link.claims as unknown as AuthClaims;
    if (!await credentialStillLive(claims)) throw new AppError(401, "UNAUTHORIZED", "the credential that created this upload link is no longer valid");
    applyBearerAuthContext(req, claims);

    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buffer.byteLength === 0) throw badRequest("upload body is empty");
    if (buffer.byteLength > link.maxBytes) throw fileTooLargeError(link.maxBytes, buffer.byteLength);
    const ext = getAllowedAttachmentExtension(link.mimeType, link.fileName);
    if (!ext) throw badRequest("unsupported file type");

    const target = await prepareCardUpload(claims, link.cardId, link.source, link.commentId);
    if (buffer.byteLength > target.uploadEntitlements.maxFileBytes) throw fileTooLargeError(target.uploadEntitlements.maxFileBytes, buffer.byteLength);
    const attachment = await storeCardAttachment(claims, target, { fileName: link.fileName, mimeType: link.mimeType, ext, buffer });
    await db.update(cardAttachmentUploadLinks).set({ attachmentId: attachment.id }).where(eq(cardAttachmentUploadLinks.id, link.id));
    return reply.status(201).send(attachmentResponse(attachment, false));
  });
}
