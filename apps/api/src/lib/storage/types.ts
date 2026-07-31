import type { Readable } from "node:stream";

export type StorageReadRange = { start: number; end?: number };

export type StorageObject = {
  body: Readable;
  contentLength: number;
  totalLength?: number;
};

export interface StorageProvider {
  put(key: string, body: Buffer, contentType: string): Promise<{ key: string }>;
  get(key: string): Promise<Buffer>;
  getObject(key: string, range?: StorageReadRange): Promise<StorageObject>;
  delete(key: string): Promise<void>;
  /**
   * Permanently removes the owning client's complete storage namespace, including orphaned objects
   * that no longer have database metadata. Reserved for whole-tenant hard-purge operations.
   */
  deleteAll(): Promise<void>;
}
