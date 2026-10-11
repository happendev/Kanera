import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { StorageConfig } from "@kanera/shared/schema";
import { Readable } from "node:stream";
import type { StorageProvider } from "./types.js";
import { acquireS3Client } from "./s3-client-cache.js";

type S3Config = Extract<StorageConfig, { kind: "s3" }>;

const S3_OPERATION_TIMEOUT_MS = 30_000; // 30 seconds

export function createS3Storage(clientId: string, config: S3Config): StorageProvider {
  const keyFor = (key: string) => `${clientId}/${key}`;

  async function withTimeout<T>(
    send: (client: S3Client, signal: AbortSignal) => Promise<T>,
    responseBody?: (response: T) => unknown,
  ): Promise<T> {
    const lease = acquireS3Client(config);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), S3_OPERATION_TIMEOUT_MS);
    let streaming = false;
    try {
      const response = await send(lease.client, controller.signal);
      const body = responseBody?.(response);
      if (body instanceof Readable && !body.destroyed && !body.readableEnded) {
        // GetObject resolves at headers, before Fastify (or get()) consumes the body. Keep its
        // client pinned until the stream finishes so cache churn cannot destroy this download.
        streaming = true;
        const release = () => {
          body.off("end", release);
          body.off("close", release);
          body.off("error", release);
          lease.release();
        };
        body.once("end", release);
        body.once("close", release);
        body.once("error", release);
      }
      return response;
    } finally {
      clearTimeout(timeout);
      if (!streaming) lease.release();
    }
  }

  return {
    async put(key, body, contentType) {
      await withTimeout((client, abortSignal) =>
        client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: keyFor(key),
            Body: body,
            ContentType: contentType,
          }),
          { abortSignal },
        ),
      );
      return { key };
    },
    async get(key) {
      const resp = await withTimeout((client, abortSignal) =>
        client.send(new GetObjectCommand({ Bucket: config.bucket, Key: keyFor(key) }), { abortSignal }),
        (response) => response.Body,
      );
      const stream = resp.Body as NodeJS.ReadableStream;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    },
    async getObject(key, range) {
      const resp = await withTimeout((client, abortSignal) =>
        client.send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: keyFor(key),
            ...(range ? { Range: `bytes=${range.start}-${range.end ?? ""}` } : {}),
          }),
          { abortSignal },
        ),
        (response) => response.Body,
      );
      const body = resp.Body;
      if (!body || !(body instanceof Readable)) throw new Error("empty s3 object body");
      return {
        body,
        contentLength: Number(resp.ContentLength ?? 0),
        totalLength: totalLengthFromContentRange(resp.ContentRange) ?? Number(resp.ContentLength ?? 0),
      };
    },
    async delete(key) {
      await withTimeout((client, abortSignal) =>
        client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: keyFor(key) }), { abortSignal }),
      );
    },
    async deleteAll() {
      const prefix = `${clientId}/`;
      let continuationToken: string | undefined;
      do {
        const listed = await withTimeout((client, abortSignal) =>
          client.send(
            new ListObjectsV2Command({
              Bucket: config.bucket,
              Prefix: prefix,
              ContinuationToken: continuationToken,
            }),
            { abortSignal },
          ),
        );
        const keys = (listed.Contents ?? []).flatMap((object) => object.Key ? [{ Key: object.Key }] : []);
        if (keys.length > 0) {
          const deleted = await withTimeout((client, abortSignal) =>
            client.send(
              new DeleteObjectsCommand({
                Bucket: config.bucket,
                Delete: { Objects: keys, Quiet: true },
              }),
              { abortSignal },
            ),
          );
          if (deleted.Errors?.length) {
            throw new Error(`S3 tenant purge failed for ${deleted.Errors.length} object(s)`);
          }
        }
        continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (continuationToken);
    },
  };
}

function totalLengthFromContentRange(contentRange: string | undefined): number | undefined {
  if (!contentRange) return undefined;
  const match = /\/(\d+)$/.exec(contentRange);
  return match ? Number(match[1]) : undefined;
}
