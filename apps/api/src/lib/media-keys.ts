import { requestContext } from "@fastify/request-context";
import { env } from "../env.js";
import { mediaPathFor, signMediaUrl } from "./media-signing.js";

declare module "@fastify/request-context" {
  interface RequestContextData {
    signedMediaCache?: Map<string, string>;
  }
}

const SIGNABLE_FIELDS = [
  "avatarUrl",
  "logoUrl",
  "url",
  "thumbnailUrl",
  "coverImageUrl",
  "uploadedByAvatarUrl",
  "actorAvatarUrl",
  "authorAvatarUrl",
] as const;

type MutableRow = Record<string, unknown>;

export function storageKeyFromMediaUrl(value: string | null | undefined, clientId?: string): string | null {
  if (!value) return null;
  const parsed = parseMediaReference(value, clientId);
  return parsed?.key ?? null;
}

export function unsignedMediaUrl(clientId: string, key: string | null | undefined): string | null {
  return key ? mediaPathFor(clientId, key) : null;
}

export function withSignedMedia<T>(clientId: string, row: T): T {
  if (!row || typeof row !== "object") return row;
  if (Array.isArray(row)) return row.map((item: unknown) => withSignedMedia(clientId, item)) as T;
  const out: MutableRow = { ...(row as MutableRow) };
  for (const field of SIGNABLE_FIELDS) {
    if (typeof out[field] === "string") out[field] = signMediaReference(out[field], clientId);
  }
  return out as T;
}

export function signMediaReference(value: string, clientId: string): string {
  const parsed = parseMediaReference(value, clientId);
  return parsed ? signCachedMediaReference(parsed.clientId, parsed.key) : value;
}

export function signEmbeddedMediaUrls(html: string | null, clientId: string): string | null {
  if (!html) return html;
  // Card descriptions and comments may contain either stored Markdown or
  // already-rendered HTML depending on the call site.
  const withHtmlSources = html.replace(/\bsrc=(["'])([^"']+)\1/g, (match, quote: string, src: string) => {
    const signed = signEmbeddedMediaReference(src, clientId);
    return signed ? `src=${quote}${signed}${quote}` : match;
  });
  return withHtmlSources.replace(/(!?\[[^\]]*\]\()([^)\s]+)(\))/g, (match, prefix: string, url: string, suffix: string) => {
    const signed = signEmbeddedMediaReference(url, clientId);
    return signed ? `${prefix}${signed}${suffix}` : match;
  });
}

export function stripSignedEmbeddedMediaUrls(html: string | null, clientId: string): string | null {
  if (!html) return html;
  const withHtmlSources = html.replace(/\bsrc=(["'])([^"']+)\1/g, (match, quote: string, src: string) => {
    const unsigned = unsignedEmbeddedMediaReference(src, clientId);
    return unsigned ? `src=${quote}${unsigned}${quote}` : match;
  });
  return withHtmlSources.replace(/(!?\[[^\]]*\]\()([^)\s]+)(\))/g, (match, prefix: string, url: string, suffix: string) => {
    const unsigned = unsignedEmbeddedMediaReference(url, clientId);
    return unsigned ? `${prefix}${unsigned}${suffix}` : match;
  });
}

export function externalEmbeddedMediaReferences(html: string | null | undefined, clientId: string): string[] {
  if (!html) return [];
  const refs = new Set<string>();
  html.replace(/\bsrc=(["'])([^"']+)\1/g, (_match, _quote: string, src: string) => {
    if (!parseMediaReference(src, clientId)) refs.add(src);
    return "";
  });
  html.replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g, (_match, _prefix: string, url: string) => {
    if (!parseMediaReference(url, clientId)) refs.add(url);
    return "";
  });
  return [...refs];
}

function signEmbeddedMediaReference(value: string, clientId: string): string | null {
  const parsed = parseMediaReference(value, clientId);
  return parsed && parsed.clientId === clientId ? signCachedMediaReference(clientId, parsed.key) : null;
}

function unsignedEmbeddedMediaReference(value: string, clientId: string): string | null {
  const parsed = parseMediaReference(value, clientId);
  return parsed && parsed.clientId === clientId ? mediaPathFor(clientId, parsed.key) : null;
}

export function parseMediaReference(value: string, expectedClientId?: string): { clientId: string; key: string } | null {
  const path = pathFromValue(value);
  const media = /^\/api\/media\/([^/]+)\/(.+)$/.exec(path);
  if (media) {
    const clientId = decodeURIComponent(media[1]!);
    if (expectedClientId && clientId !== expectedClientId) return null;
    return { clientId, key: decodeKey(media[2]!) };
  }
  return null;
}

function pathFromValue(value: string): string {
  try {
    return new URL(value, env.API_PUBLIC_URL).pathname;
  } catch {
    return value.split("?")[0] ?? value;
  }
}

function decodeKey(value: string): string {
  return value.split("/").map((part) => decodeURIComponent(part)).join("/");
}

function signCachedMediaReference(clientId: string, key: string): string {
  const cacheKey = `${clientId}:${key}`;
  let cache = requestContext.get("signedMediaCache");
  if (!cache) {
    cache = new Map<string, string>();
    requestContext.set("signedMediaCache", cache);
  }
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const signed = signMediaUrl({ clientId, key });
  cache.set(cacheKey, signed);
  return signed;
}
