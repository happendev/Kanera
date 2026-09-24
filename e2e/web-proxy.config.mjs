// Dev-server proxy for the E2E web build. It mirrors the production routes in apps/web/nginx.conf
// so browser tests cover same-origin routing instead of the dev build's direct CORS calls.
import { readFileSync } from "node:fs";

const ports = JSON.parse(readFileSync(new URL("./ports.json", import.meta.url), "utf8"));
const api = `http://localhost:${ports.api}`;

export default {
  "/api": {
    target: api,
    changeOrigin: true,
    pathRewrite: { "^/api": "" },
    // nginx rewrites the refresh cookie from /auth to /api/auth; without this the browser would
    // never send kanera_rt back through the /api prefix and every reload would sign the user out.
    cookiePathRewrite: { "/auth": "/api/auth" },
  },
  "/socket.io": { target: api, changeOrigin: true, ws: true },
  "/public-api": {
    target: `http://localhost:${ports.publicApi}`,
    changeOrigin: true,
    pathRewrite: { "^/public-api": "" },
  },
};
