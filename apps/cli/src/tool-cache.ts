import { InMemoryResponseCacheStore, isSpecType, type CacheEntry, type CacheKey, type ResponseCacheStore } from "@modelcontextprotocol/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./config.js";

const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_TTL_MS = 5 * 60_000;
type StoredCatalog = { key: CacheKey; entry: CacheEntry };

/**
 * Persist only explicitly public tool catalogues. The SDK retains ownership of TTL, server-version
 * partitions and invalidation; discovery still authenticates every new
 * connection. Endpoint hashing additionally prevents two self-hosted servers with identical
 * name/version strings from sharing a catalogue. Credentials and resource/tool results stay out.
 */
export class ToolCatalogCache implements ResponseCacheStore {
  private readonly memory = new InMemoryResponseCacheStore();
  private readonly directory: string;
  private readonly path: string;
  private loaded = false;

  constructor(endpoint: string, directory = join(configDir(), "tool-cache")) {
    this.directory = directory;
    this.path = join(directory, createHash("sha256").update(new URL(endpoint).toString()).digest("hex") + ".json");
  }

  async get(key: CacheKey): Promise<CacheEntry | undefined> {
    if (key.method === "tools/list" && !this.loaded) {
      this.loaded = true;
      try {
        if ((await stat(this.path)).size <= MAX_CACHE_BYTES) {
          const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<StoredCatalog>;
          const entry = parsed.entry;
          if (parsed.key?.method === "tools/list" && typeof parsed.key.partition === "string"
            && (parsed.key.params === undefined || parsed.key.params === "")
            && entry?.scope === "public" && typeof entry.value === "string"
            && typeof entry.expiresAt === "number" && Number.isFinite(entry.expiresAt)
            && entry.expiresAt > Date.now() && entry.expiresAt <= Date.now() + MAX_TTL_MS) {
            // Do not let an interrupted/invalid cache turn an otherwise working command into an
            // SDK decoder failure. Cache hits bypass the client's wire-response validation, so
            // validate the entire catalogue with the same protocol schema before hydrating it.
            const value: unknown = JSON.parse(entry.value);
            if (isSpecType.ListToolsResult(value)) {
              this.memory.set(parsed.key, entry);
            }
          }
        }
      } catch { /* An absent, unwritable or corrupt optional cache is a normal miss. */ }
    }
    return this.memory.get(key);
  }

  async set(key: CacheKey, entry: Omit<CacheEntry, "stamp">): Promise<number> {
    const stamp = this.memory.set(key, entry);
    if (key.method !== "tools/list") return stamp;
    if (entry.scope !== "public" || !entry.expiresAt || entry.expiresAt <= Date.now()) {
      // A server can withdraw public caching. Do not leave the previous public catalogue on disk
      // for the next process after observing a replacement that must stay session-local.
      await this.removeFile();
      return stamp;
    }
    this.loaded = true;
    const payload = JSON.stringify({ key, entry: { ...entry, expiresAt: Math.min(entry.expiresAt, Date.now() + MAX_TTL_MS) } });
    if (Buffer.byteLength(payload) > MAX_CACHE_BYTES) {
      await this.removeFile();
      return stamp;
    }
    const temporary = this.path + "." + randomUUID() + ".tmp";
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, payload, { flag: "wx", mode: 0o600 });
      // Parallel CLI commands must see one complete catalogue, never a partially written schema.
      await rename(temporary, this.path);
    } catch { /* Caching must not make a working remote command depend on local disk access. */ }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
    return stamp;
  }

  async delete(key: CacheKey): Promise<void> {
    this.memory.delete(key);
    if (key.method === "tools/list") await this.removeFile();
  }

  async evict(method: string): Promise<void> {
    this.memory.evict(method);
    if (method === "tools/list") await this.removeFile();
  }

  async clear(): Promise<void> {
    this.memory.clear();
    await this.removeFile();
  }

  private async removeFile(): Promise<void> {
    this.loaded = true;
    await rm(this.path, { force: true }).catch(() => {});
  }
}
