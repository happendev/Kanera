import type { OnDestroy } from "@angular/core";
import { Injectable, computed, inject, signal } from "@angular/core";
import { getAllowedAttachmentExtension } from "@kanera/shared/attachments";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { attachmentIconClass } from "../attachment-icons";
import { fileTooLargeMessage, storageFullMessage } from "../storage-messages";

/**
 * One in-flight (or failed) upload. Successful uploads are removed from the queue — the resulting
 * attachment shows up in the panel's own list (via realtime for cards, local prepend for notes),
 * so keeping a "done" item here would just duplicate it.
 */
export interface UploadItem {
  id: string;
  fileName: string;
  icon: string; // Tabler icon class derived from the file's mime/extension
  progress: number; // 0-100
  status: "uploading" | "error";
  error?: string;
  // false for permanent failures (too large, quota) where resending the same file can't succeed —
  // the UI hides Retry and only offers dismiss.
  retryable?: boolean;
}

interface UploadQueueConfig {
  /** Built lazily so it can read the current card/note id at send time. */
  path: () => string;
  /** Optional post-success hook (notes prepend locally; cards rely on the realtime event). */
  onUploaded?: (row: unknown) => void;
}

/**
 * Per-file upload queue shared by the card-detail and note-editor attachment dropzones. Owns the
 * progress/retry state and the validation + error formatting that used to be duplicated in both
 * components. Component-provided (not root): each panel gets its own independent queue.
 */
@Injectable()
export class AttachmentUploadQueue implements OnDestroy {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);

  readonly items = signal<UploadItem[]>([]);
  // Drag/paste guards and the dropzone label key off this, preserving the old `uploadingAttachment`.
  readonly busy = computed(() => this.items().some((i) => i.status === "uploading"));
  // Pre-flight failures (unsupported type) — distinct from per-file transport errors, which are
  // retryable and live on the item itself.
  readonly validationError = signal<string | null>(null);

  private config: UploadQueueConfig | null = null;
  // Retained so retry() can resend without the user re-picking the file.
  private readonly files = new Map<string, File>();
  // One controller per in-flight upload so it can be aborted on switch/teardown.
  private readonly controllers = new Map<string, AbortController>();
  private seq = 0;

  configure(config: UploadQueueConfig): void {
    this.config = config;
  }

  add(files: File[]): void {
    if (files.length === 0) return;
    this.validationError.set(null);
    for (const file of files) {
      const invalid = this.validationError_(file);
      if (invalid) {
        // Surface the first invalid file and skip it; valid files still upload.
        this.validationError.set(invalid);
        continue;
      }
      // Start each file concurrently so every row gets its own live progress bar and one slow or
      // failed upload never blocks the others.
      void this.start(file);
    }
  }

  retry(id: string): void {
    const file = this.files.get(id);
    if (!file) return;
    void this.start(file, id);
  }

  dismiss(id: string): void {
    this.files.delete(id);
    this.items.update((rows) => rows.filter((row) => row.id !== id));
  }

  /**
   * Drop all queue state and abort any in-flight uploads. Call when the host switches to a different
   * card/note: the queue instance is reused across entities, and a retained item's retry would
   * otherwise post to the wrong one (path() reads the current id at send time).
   */
  reset(): void {
    this.abortAll();
    this.files.clear();
    this.items.set([]);
    this.validationError.set(null);
  }

  // Abort in-flight uploads when the host component is destroyed (panel closed / route left) so we
  // don't leave orphaned requests running after their UI is gone.
  ngOnDestroy(): void {
    this.abortAll();
  }

  private abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  private async start(file: File, existingId?: string): Promise<void> {
    const id = existingId ?? `upload-${++this.seq}`;
    this.files.set(id, file);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.upsert({ id, fileName: file.name, icon: attachmentIconClass(file.type, file.name), progress: 0, status: "uploading" });

    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const row = await this.api.upload<unknown>(this.config!.path(), form, {
        onProgress: (pct) => this.patch(id, { progress: pct }),
        signal: controller.signal,
      });
      this.files.delete(id);
      this.items.update((rows) => rows.filter((r) => r.id !== id));
      this.config?.onUploaded?.(row);
    } catch (err) {
      // An abort (reset/teardown) clears the queue, so the item is already gone — patch() is a no-op
      // and we surface no error. A genuine failure leaves an error item, retryable unless the failure
      // is permanent for this file (too large / out of storage), where resending can't help.
      this.patch(id, { status: "error", error: this.formatUploadError(err), retryable: !this.isPermanentError(err) });
    } finally {
      this.controllers.delete(id);
    }
  }

  private upsert(item: UploadItem): void {
    this.items.update((rows) => {
      const idx = rows.findIndex((r) => r.id === item.id);
      if (idx === -1) return [...rows, item];
      const next = rows.slice();
      next[idx] = item;
      return next;
    });
  }

  private patch(id: string, changes: Partial<UploadItem>): void {
    this.items.update((rows) => rows.map((r) => (r.id === id ? { ...r, ...changes } : r)));
  }

  // Client-knowable check only. Per-file size is enforced server-side against the board/note OWNER's
  // tier (host-pays storage), which the client can't reliably know — a free guest may legitimately
  // upload large files to a paid host. The server's FILE_TOO_LARGE response (carrying maxFileBytes)
  // drives any size error via formatUploadError.
  private validationError_(file: File): string | null {
    if (!getAllowedAttachmentExtension(file.type, file.name)) return "Unsupported file type";
    return null;
  }

  // Failures inherent to this file/account rather than transient: retrying the same file won't help,
  // so the UI offers only dismiss. Mirrors the branches in formatUploadError.
  private isPermanentError(err: unknown): boolean {
    if (!(err instanceof ApiError)) return false;
    const body = err.body as { code?: string; message?: string } | null;
    if (body?.code === "STORAGE_QUOTA_EXCEEDED") return true;
    return err.status === 413 || body?.message === "file too large" || body?.code === "FILE_TOO_LARGE";
  }

  private formatUploadError(err: unknown): string {
    if (err instanceof ApiError) {
      const body = err.body as { code?: string; message?: string; maxFileBytes?: number } | null;
      if (body?.code === "STORAGE_QUOTA_EXCEEDED") return storageFullMessage(this.auth.isOrgAdmin());
      if (err.status === 413 || body?.message === "file too large" || body?.code === "FILE_TOO_LARGE") {
        return fileTooLargeMessage(this.maxAttachmentLabel(body?.maxFileBytes), this.auth.isOrgAdmin(), this.auth.isPlanLimited());
      }
      if (body?.message) return body.message;
      return "Upload failed";
    }
    return err instanceof Error && err.message ? err.message : "Upload failed";
  }

  private maxAttachmentLabel(value = this.auth.user()?.storageUsage?.maxFileBytes ?? Number.POSITIVE_INFINITY): string {
    return Number.isFinite(value) ? this.formatBytes(value).replace(".0 ", " ") : "configured limit";
  }

  private formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
}
