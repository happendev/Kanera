import { Injectable, inject, signal } from "@angular/core";
import { ALLOWED_ATTACHMENT_EXTENSIONS, ALLOWED_ATTACHMENT_MIME, getAllowedAttachmentExtension } from "@kanera/shared/attachments";
import type { Editor } from "@tiptap/core";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { fileTooLargeMessage, storageFullMessage } from "../../shared/storage-messages";

const IMAGE_MIMES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml",
]);
export const DESCRIPTION_EDITOR_ALLOWED_MIMES: ReadonlySet<string> = new Set(Object.keys(ALLOWED_ATTACHMENT_MIME));
export const DESCRIPTION_EDITOR_ACCEPT = [
  ...Object.keys(ALLOWED_ATTACHMENT_MIME),
  ...ALLOWED_ATTACHMENT_EXTENSIONS.map((ext) => `.${ext}`),
].join(",");

export type AttachmentSource = "description" | "comment";
export type AttachmentTarget =
  | { kind: "card"; id: string }
  | { kind: "note"; id: string }
  | { kind: "scratchpad"; id: string };

@Injectable()
export class DescriptionEditorUploader {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private attachmentIds: string[] = [];

  readonly uploading = signal(false);
  readonly error = signal<string | null>(null);

  attachmentIdsSnapshot(): string[] {
    return this.attachmentIds.slice();
  }

  reset() {
    this.attachmentIds = [];
    this.error.set(null);
  }

  async uploadAndInsert(file: File, editor: Editor | null, target: AttachmentTarget, source: AttachmentSource) {
    this.error.set(null);
    const validationError = this.validationError(file);
    if (validationError) {
      this.error.set(validationError);
      return;
    }

    this.uploading.set(true);
    let uploaded: { id: string; url: string } | null = null;
    try {
      const form = new FormData();
      form.append("file", file);
      const qs = new URLSearchParams({ source }).toString();
      // The scratchpad has no attachment list, so every upload is a body embed and there is no
      // `source` distinction to send — its route takes no query parameters at all.
      const path = target.kind === "card"
        ? `/cards/${target.id}/attachments?${qs}`
        : target.kind === "note"
          ? `/notes/${target.id}/attachments?${qs}`
          : `/scratchpad/notes/${target.id}/attachments`;
      uploaded = await this.api.request<{ id: string; url: string }>(
        path,
        { method: "POST", body: form },
      );
      const inserted = IMAGE_MIMES.has(file.type)
        ? editor?.chain().focus().setImage({ src: uploaded.url }).run()
        : editor
          ?.chain()
          .focus()
          .insertContent({
            type: "paragraph",
            content: [{ type: "text", text: file.name, marks: [{ type: "link", attrs: { href: uploaded.url } }] }],
          })
          .run();

      // Scratchpad files have no attachment-list fallback: if the editor disappeared or rejected the
      // command, the upload would be permanently invisible while still consuming organisation quota.
      if (target.kind === "scratchpad" && !inserted) {
        await this.rollbackScratchpadUpload(target.id, uploaded.id);
        uploaded = null;
        this.error.set("Couldn't insert the uploaded file");
        return;
      }
      this.attachmentIds.push(uploaded.id);
    } catch (err) {
      if (target.kind === "scratchpad" && uploaded) {
        await this.rollbackScratchpadUpload(target.id, uploaded.id);
      }
      this.error.set(err instanceof ApiError ? this.formatApiError(err) : "Upload failed");
    } finally {
      this.uploading.set(false);
    }
  }

  private async rollbackScratchpadUpload(noteId: string, attachmentId: string): Promise<void> {
    try {
      await this.api.request(`/scratchpad/notes/${noteId}/attachments/${attachmentId}`, { method: "DELETE" });
    } catch {
      // The content PATCH also performs reachability cleanup once an embed has been saved. This path
      // is best-effort for the narrower upload-before-insert failure window.
    }
  }

  isAllowedFile(file: File): boolean {
    return getAllowedAttachmentExtension(file.type, file.name) !== null;
  }

  private validationError(file: File): string | null {
    // Per-file size is enforced server-side against the board OWNER's tier (host-pays storage), which
    // the client can't reliably know — a free guest may legitimately upload large files to a paid
    // host board. So we only do the client-knowable file-type check here and let the server's
    // FILE_TOO_LARGE response (which carries the correct maxFileBytes) drive any size error.
    if (!this.isAllowedFile(file)) return "Unsupported file type";
    return null;
  }

  private formatApiError(err: ApiError): string {
    const body = err.body as { code?: string; message?: string; maxFileBytes?: number } | null;
    if (body?.code === "STORAGE_QUOTA_EXCEEDED") return storageFullMessage(this.auth.isOrgAdmin());
    if (err.status === 413 || body?.message === "file too large" || body?.code === "FILE_TOO_LARGE") {
      return fileTooLargeMessage(this.maxAttachmentLabel(body?.maxFileBytes), this.auth.isOrgAdmin(), this.auth.isPlanLimited());
    }
    if (body?.message) return body.message;
    return `Upload failed (${err.status})`;
  }

  private maxAttachmentBytes(): number {
    return this.auth.user()?.storageUsage?.maxFileBytes ?? Number.POSITIVE_INFINITY;
  }

  private maxAttachmentLabel(value = this.maxAttachmentBytes()): string {
    return Number.isFinite(value) ? this.formatBytes(value).replace(".0 ", " ") : "configured limit";
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }
}
