import type { FastifyInstance, FastifyReply } from "fastify";
import type helmet from "@fastify/helmet";

type HelmetOptions = NonNullable<Parameters<typeof helmet>[1]>;

export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; base-uri 'none'; frame-ancestors 'self'";
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "ambient-light-sensor=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=(self)",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=(self)",
  "screen-wake-lock=()",
  "sync-xhr=()",
  "usb=()",
  "web-share=(self)",
  "xr-spatial-tracking=()",
].join(", ");

export const helmetSecurityOptions = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  frameguard: { action: "sameorigin" },
  hsts: { maxAge: 31_536_000, includeSubDomains: true },
  noSniff: true,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
} satisfies HelmetOptions;

export const helmetSecurityOptionsWithoutCsp = {
  ...helmetSecurityOptions,
  contentSecurityPolicy: false,
} satisfies HelmetOptions;

export function registerApiContentSecurityPolicy(app: FastifyInstance) {
  app.addHook("onSend", async (_req, reply, payload) => {
    if (!reply.hasHeader("Content-Security-Policy") && !isHtmlResponse(reply)) {
      reply.header("Content-Security-Policy", API_CONTENT_SECURITY_POLICY);
    }
    return payload;
  });
}

export function registerSecurityHeaderFallbacks(app: FastifyInstance) {
  app.addHook("onSend", async (_req, reply, payload) => {
    if (!reply.hasHeader("Permissions-Policy")) {
      reply.header("Permissions-Policy", PERMISSIONS_POLICY);
    }
    return payload;
  });
}

function isHtmlResponse(reply: FastifyReply) {
  const contentType = reply.getHeader("content-type");
  return typeof contentType === "string" && contentType.toLowerCase().includes("text/html");
}
