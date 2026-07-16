import type { FastifyInstance } from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getStorageForClient } from "../../lib/storage/index.js";
import { mediaCacheMaxAge, verifyMediaToken } from "../../lib/media-signing.js";
import { parseMediaReference, signMediaReference } from "../../lib/media-keys.js";
import { notFound } from "../../lib/errors.js";
import type { AuthClaims } from "../../auth/plugin.js";

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  pdf: "application/pdf",
};

export function mediaContentTypeForKey(key: string): string {
  const ext = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export async function mediaRoutes(app: FastifyInstance) {
  // Authenticated on-demand re-sign: the frontend recovery service calls this
  // when a cached signed URL 404s (expiry past the overlap window, secret
  // rotation, client clock skew) to mint the current window's URL for one asset.
  // Registered at both prefixes for the same reason serveMedia is (see below).
  app.get("/media/resign", { preHandler: app.authenticate }, resignMedia);
  app.get("/api/media/resign", { preHandler: app.authenticate }, resignMedia);

  app.get("/media/:clientId/*", serveMedia);
  // Signed media URLs intentionally include the web/API prefix (`/api/media/...`).
  // The web dev proxy strips `/api`, but direct API or self-hosted rewrites may
  // not, so serve the same immutable media route at both paths.
  app.get("/api/media/:clientId/*", serveMedia);
}

async function resignMedia(req: FastifyRequest, reply: FastifyReply) {
  const query = req.query as { u?: string };
  const reference = query.u;
  if (!reference) throw notFound();
  const parsed = parseMediaReference(reference);
  // Only re-sign media owned by the caller's tenant. Use 404 (not 403) so the
  // endpoint never discloses whether a foreign tenant or key exists. Cross-org
  // guest media is the rare exception and is already covered by long validity.
  if (!parsed || parsed.clientId !== req.auth.cid) throw notFound();
  // signMediaReference is deterministic within a window, so this returns the
  // same cacheable URL the board/detail views already use — not a per-request one.
  return reply.send({ url: signMediaReference(reference, req.auth.cid) });
}

async function serveMedia(req: FastifyRequest, reply: FastifyReply) {
    const params = req.params as { clientId: string; "*": string };
    const query = req.query as { t?: string; e?: string; s?: string; fn?: string };
    const clientId = decodeURIComponent(params.clientId);
    // Storage providers own their final key handling; the route only normalizes
    // unsafe characters within path segments while preserving nested keys.
    const key = params["*"].split("/").map((part) => decodeURIComponent(part).replace(/[^a-zA-Z0-9._-]/g, "_")).join("/");
    // Use 404 for any auth/token/storage miss so the route does not disclose
    // whether a tenant or object key exists.
    if (!query.t || !query.e || !verifyMediaToken({ clientId, key, t: query.t, e: query.e, s: query.s })) throw notFound();
    if (req.headers.authorization) {
      try {
        await req.jwtVerify();
      } catch {
        throw notFound();
      }
      if ((req.user as AuthClaims).cid !== clientId) throw notFound();
    }

    const storage = await getStorageForClient(clientId);
    let object;
    const range = parseRangeHeader(req.headers.range);
    try {
      object = await storage.getObject(key, range ?? undefined);
    } catch {
      throw notFound();
    }
    const maxAgeSeconds = Math.floor(mediaCacheMaxAge(query.e, query.s === "share" ? "share" : "session") / 1000);
    reply
      // Uploaded files are immutable, and the signed URL already carries the
      // authorization decision, so shared caches such as Cloudflare may store it.
      .header("Cache-Control", `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}, immutable`)
      .header("Content-Type", mediaContentTypeForKey(key))
      // User-uploaded files (notably SVG) are attacker-controlled content served from this origin.
      // An SVG opened as a top-level document can run embedded <script>, so neutralize active
      // content here: `sandbox` with no allow-* tokens blocks scripts/plugins/forms, `default-src
      // 'none'` blocks any subresource loads, and `nosniff` stops the browser from re-interpreting
      // the declared type. `<img>`-embedded media is unaffected (SVG scripts never run via <img>).
      .header("Content-Security-Policy", "default-src 'none'; sandbox; style-src 'unsafe-inline'")
      .header("X-Content-Type-Options", "nosniff")
      .header("Accept-Ranges", "bytes")
      .header("Content-Length", String(object.contentLength));
    if (range && object.totalLength !== undefined) {
      const end = range.end ?? range.start + object.contentLength - 1;
      reply.status(206).header("Content-Range", `bytes ${range.start}-${end}/${object.totalLength}`);
    }
    if (query.fn) {
      reply.header("Content-Disposition", attachmentDisposition(query.fn));
    }
    return reply.send(object.body);
}

function parseRangeHeader(value: string | undefined): { start: number; end?: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  if (!Number.isSafeInteger(start) || start < 0) return null;
  if (end !== undefined && (!Number.isSafeInteger(end) || end < start)) return null;
  return { start, ...(end !== undefined ? { end } : {}) };
}

function attachmentDisposition(fileName: string): string {
  const fallback = fileName
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\\"]/g, "_")
    .replace(/[\r\n]/g, " ")
    .trim() || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987ValueChars(fileName)}`;
}

function encodeRFC5987ValueChars(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
