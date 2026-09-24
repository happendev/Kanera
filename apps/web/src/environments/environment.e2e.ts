// Browser E2E build: development compilation with production's same-origin routing. The E2E
// dev-server proxy (e2e/web-proxy.config.mjs) mirrors apps/web/nginx.conf, so tests exercise the
// /api prefix, the rewritten refresh-cookie path and the proxied socket like a deployment does.
export const environment = {
  production: false,
  apiUrl: "/api",
  socketUrl: "/",
  publicApiUrl: "/public-api",
};
