import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { AttachmentUploadQueue } from "./attachment-upload-queue.service";

/** A single pending upload whose progress and settlement the test drives by hand. */
interface PendingUpload {
  onProgress?: (pct: number) => void;
  resolve: (row: unknown) => void;
  reject: (err: unknown) => void;
}

class FakeApiClient {
  readonly pending: PendingUpload[] = [];
  upload<T>(_path: string, _form: FormData, opts: { onProgress?: (pct: number) => void; signal?: AbortSignal } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Mirror ApiClient.upload: an aborted signal rejects with the cancelled ApiError.
      opts.signal?.addEventListener("abort", () => reject(new ApiError(0, { message: "Upload cancelled" })), { once: true });
      this.pending.push({ onProgress: opts.onProgress, resolve: resolve as (row: unknown) => void, reject });
    });
  }
}

const fakeAuth = {
  isOrgAdmin: () => false,
  isPlanLimited: () => false,
  user: () => null,
} as unknown as AuthService;

function file(name = "doc.pdf"): File {
  return new File(["data"], name, { type: "application/pdf" });
}

describe("AttachmentUploadQueue", () => {
  let queue: AttachmentUploadQueue;
  let api: FakeApiClient;
  let uploaded: unknown[];

  beforeEach(() => {
    api = new FakeApiClient();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        AttachmentUploadQueue,
        { provide: ApiClient, useValue: api },
        { provide: AuthService, useValue: fakeAuth },
      ],
    });
    queue = TestBed.inject(AttachmentUploadQueue);
    uploaded = [];
    queue.configure({ path: () => "/cards/c1/attachments", onUploaded: (row) => uploaded.push(row) });
  });

  it("tracks progress, then removes the item and fires onUploaded on success", async () => {
    queue.add([file()]);
    expect(queue.items()).toHaveLength(1);
    expect(queue.busy()).toBe(true);
    expect(queue.items()[0]!.progress).toBe(0);

    api.pending[0]!.onProgress?.(42);
    expect(queue.items()[0]!.progress).toBe(42);

    const id = "att-1";
    api.pending[0]!.resolve({ id });
    await Promise.resolve(); // let the awaited upload settle

    expect(queue.items()).toHaveLength(0);
    expect(queue.busy()).toBe(false);
    expect(uploaded).toEqual([{ id }]);
  });

  it("flips an item to a retryable error (no onUploaded) when the upload fails transiently", async () => {
    queue.add([file()]);
    api.pending[0]!.reject(new ApiError(500, { message: "Boom" }));
    await Promise.resolve();

    expect(queue.items()).toHaveLength(1);
    expect(queue.items()[0]!.status).toBe("error");
    expect(queue.items()[0]!.error).toBe("Boom");
    expect(queue.items()[0]!.retryable).toBe(true);
    expect(queue.busy()).toBe(false);
    expect(uploaded).toEqual([]);
  });

  it("marks too-large and quota failures as non-retryable", async () => {
    queue.add([file()]);
    api.pending[0]!.reject(new ApiError(413, { code: "FILE_TOO_LARGE", maxFileBytes: 1024 }));
    await Promise.resolve();
    expect(queue.items()[0]!.status).toBe("error");
    expect(queue.items()[0]!.retryable).toBe(false);

    queue.dismiss(queue.items()[0]!.id);
    queue.add([file("other.pdf")]);
    api.pending[1]!.reject(new ApiError(403, { code: "STORAGE_QUOTA_EXCEEDED" }));
    await Promise.resolve();
    expect(queue.items()[0]!.retryable).toBe(false);
  });

  it("retry re-uploads the same file, clears the error, and resolves", async () => {
    queue.add([file()]);
    api.pending[0]!.reject(new ApiError(500, { message: "Boom" }));
    await Promise.resolve();
    const id = queue.items()[0]!.id;

    queue.retry(id);
    // Same item id is reused and put back into the uploading state.
    expect(queue.items()).toHaveLength(1);
    expect(queue.items()[0]!.status).toBe("uploading");
    expect(api.pending).toHaveLength(2);

    api.pending[1]!.resolve({ id: "att-2" });
    await Promise.resolve();

    expect(queue.items()).toHaveLength(0);
    expect(uploaded).toEqual([{ id: "att-2" }]);
  });

  it("aborts in-flight uploads on reset without surfacing a cancellation error", async () => {
    queue.add([file()]);
    expect(queue.items()).toHaveLength(1);

    queue.reset();
    // The aborted upload rejects asynchronously; reset already cleared the queue, so no error item
    // should reappear.
    await Promise.resolve();
    await Promise.resolve();

    expect(queue.items()).toHaveLength(0);
    expect(queue.busy()).toBe(false);
  });

  it("aborts the in-flight request when the host is destroyed", async () => {
    queue.add([file()]);
    queue.ngOnDestroy();
    await Promise.resolve();

    // The fake rejects via the abort signal, proving ngOnDestroy aborted the underlying request.
    expect(queue.items()[0]!.error).toBe("Upload cancelled");
  });

  it("rejects unsupported file types up front without starting an upload", () => {
    queue.add([new File(["x"], "evil.exe", { type: "application/x-msdownload" })]);
    expect(queue.validationError()).toBe("Unsupported file type");
    expect(queue.items()).toHaveLength(0);
    expect(api.pending).toHaveLength(0);
  });
});
