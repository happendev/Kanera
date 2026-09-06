import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../../env.js";
import type { StorageProvider } from "./types.js";

// Keep local uploads out of apps/api even when pnpm starts the API with the package as cwd.
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

function safeLocalKey(key: string): string {
  const parts = key.split("/").map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_"));
  // "." and ".." survive the character allowlist, so reject them explicitly: a traversing key
  // would otherwise let path.join() escape the tenant directory.
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("invalid storage key");
  return parts.join("/");
}

// Final containment check on the resolved path; belt-and-braces alongside safeLocalKey.
function resolveWithin(clientDir: string, safeKey: string): string {
  const filePath = path.resolve(clientDir, safeKey);
  if (filePath !== clientDir && !filePath.startsWith(clientDir + path.sep)) throw new Error("invalid storage key");
  return filePath;
}

export function resolveLocalUploadsRoot(uploadsDir = env.UPLOADS_DIR): string {
  return path.isAbsolute(uploadsDir) ? uploadsDir : path.resolve(workspaceRoot, uploadsDir);
}

export function createLocalStorage(clientId: string): StorageProvider {
  const rootDir = resolveLocalUploadsRoot();
  // Client ids are UUIDs in production. Keep this segment non-traversable as defense in depth because
  // deleteAll() recursively removes this directory during an explicitly requested tenant purge.
  const safeClientId = clientId.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!safeClientId || safeClientId === "_" || safeClientId === "__") {
    throw new Error("invalid storage client id");
  }
  const clientDir = path.resolve(rootDir, safeClientId);

  return {
    async put(key, body) {
      const safeKey = safeLocalKey(key);
      await mkdir(path.dirname(resolveWithin(clientDir, safeKey)), { recursive: true });
      await writeFile(resolveWithin(clientDir, safeKey), body);
      return { key };
    },
    async get(key) {
      const safeKey = safeLocalKey(key);
      return readFile(resolveWithin(clientDir, safeKey));
    },
    async getObject(key, range) {
      const safeKey = safeLocalKey(key);
      const filePath = resolveWithin(clientDir, safeKey);
      const info = await stat(filePath);
      const start = range?.start ?? 0;
      const end = range?.end ?? info.size - 1;
      return {
        body: createReadStream(filePath, { start, end }),
        contentLength: Math.max(0, end - start + 1),
        totalLength: info.size,
      };
    },
    async delete(key) {
      const safeKey = safeLocalKey(key);
      await rm(resolveWithin(clientDir, safeKey), { force: true });
    },
    async deleteAll() {
      await rm(clientDir, { recursive: true, force: true });
    },
  };
}
