import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../../env.js";
import type { StorageProvider } from "./types.js";

// Keep local uploads out of apps/api even when pnpm starts the API with the package as cwd.
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

function safeLocalKey(key: string): string {
  return key.split("/").map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_")).join("/");
}

export function resolveLocalUploadsRoot(uploadsDir = env.UPLOADS_DIR): string {
  return path.isAbsolute(uploadsDir) ? uploadsDir : path.resolve(workspaceRoot, uploadsDir);
}

export function createLocalStorage(clientId: string): StorageProvider {
  const rootDir = resolveLocalUploadsRoot();
  const clientDir = path.join(rootDir, clientId);

  return {
    async put(key, body) {
      const safeKey = safeLocalKey(key);
      await mkdir(path.dirname(path.join(clientDir, safeKey)), { recursive: true });
      await writeFile(path.join(clientDir, safeKey), body);
      return { key };
    },
    async get(key) {
      const safeKey = safeLocalKey(key);
      return readFile(path.join(clientDir, safeKey));
    },
    async getObject(key, range) {
      const safeKey = safeLocalKey(key);
      const filePath = path.join(clientDir, safeKey);
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
      await rm(path.join(clientDir, safeKey), { force: true });
    },
  };
}
