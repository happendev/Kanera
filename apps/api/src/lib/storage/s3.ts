import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { StorageConfig } from "@kanera/shared/schema";
import { Readable } from "node:stream";
import type { StorageProvider } from "./types.js";

type S3Config = Extract<StorageConfig, { kind: "s3" }>;

const S3_OPERATION_TIMEOUT_MS = 30_000; // 30 seconds

export function createS3Storage(clientId: string, config: S3Config): StorageProvider {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: !!config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  const keyFor = (key: string) => `${clientId}/${key}`;

  async function withTimeout<T>(send: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), S3_OPERATION_TIMEOUT_MS);
    try {
      return await send(controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async put(key, body, contentType) {
      await withTimeout((abortSignal) =>
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
      const resp = await withTimeout((abortSignal) =>
        client.send(new GetObjectCommand({ Bucket: config.bucket, Key: keyFor(key) }), { abortSignal }),
      );
      const stream = resp.Body as NodeJS.ReadableStream;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    },
    async getObject(key, range) {
      const resp = await withTimeout((abortSignal) =>
        client.send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: keyFor(key),
            ...(range ? { Range: `bytes=${range.start}-${range.end ?? ""}` } : {}),
          }),
          { abortSignal },
        ),
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
      await withTimeout((abortSignal) =>
        client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: keyFor(key) }), { abortSignal }),
      );
    },
    async deleteAll() {
      const prefix = `${clientId}/`;
      let continuationToken: string | undefined;
      do {
        const listed = await withTimeout((abortSignal) =>
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
          const deleted = await withTimeout((abortSignal) =>
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
