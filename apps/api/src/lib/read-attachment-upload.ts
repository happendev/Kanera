import { getAllowedAttachmentExtension } from "@kanera/shared/attachments";
import type { FastifyRequest } from "fastify";
import { AppError, badRequest } from "./errors.js";
import { formatStorageBytes } from "./entitlements.js";

function fileTooLargeError(maxFileBytes: number, attemptedBytes?: number) {
  return new AppError(
    400,
    "FILE_TOO_LARGE",
    `File is too large. The maximum file size is ${formatStorageBytes(maxFileBytes)}.`,
    { limit: "fileSize", maxFileBytes, ...(attemptedBytes !== undefined ? { attemptedBytes } : {}) },
  );
}

// Call only after access and the owning organisation's storage preflight have passed.
// Quota accounting and physical storage tenancy remain the caller's responsibility.
export async function readAttachmentUpload(req: FastifyRequest, maxFileBytes: number) {
  const file = await req
    .file({ limits: { fileSize: maxFileBytes, files: 1 } })
    .catch((err: unknown) => {
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        throw fileTooLargeError(maxFileBytes);
      }
      return null;
    });
  if (!file) throw badRequest("no file uploaded");

  const ext = getAllowedAttachmentExtension(file.mimetype, file.filename);
  if (!ext) throw badRequest("unsupported file type");

  const buffer = await file.toBuffer().catch((err: unknown) => {
    if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      throw fileTooLargeError(maxFileBytes);
    }
    throw err;
  });
  if (buffer.byteLength > maxFileBytes) {
    throw fileTooLargeError(maxFileBytes, buffer.byteLength);
  }
  return { file, ext, buffer };
}
