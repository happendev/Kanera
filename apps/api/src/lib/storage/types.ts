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
}
