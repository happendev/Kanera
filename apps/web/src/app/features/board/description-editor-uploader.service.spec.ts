import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { DescriptionEditorUploader } from "./description-editor-uploader.service";

describe("DescriptionEditorUploader", () => {
  let api: { request: ReturnType<typeof vi.fn> };
  let uploader: DescriptionEditorUploader;
  let isOrgAdmin: ReturnType<typeof signal<boolean>>;
  let isPlanLimited: ReturnType<typeof signal<boolean>>;

  beforeEach(() => {
    api = { request: vi.fn() };
    isOrgAdmin = signal(false);
    isPlanLimited = signal(false);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        DescriptionEditorUploader,
        { provide: ApiClient, useValue: api },
        {
          provide: AuthService,
          useValue: {
            user: signal({
              storageUsage: {
                maxFileBytes: 250 * 1024 * 1024,
              },
            }),
            isOrgAdmin,
            isPlanLimited,
          },
        },
      ],
    });
    uploader = TestBed.inject(DescriptionEditorUploader);
  });

  it("shows a role-aware message when the org storage quota is exceeded", async () => {
    api.request.mockRejectedValue(new ApiError(403, { code: "STORAGE_QUOTA_EXCEEDED" }));

    // Members are told to ask an admin; admins are told to upgrade the plan.
    await uploader.uploadAndInsert(
      new File(["hello"], "quota.txt", { type: "text/plain" }),
      null,
      { kind: "card", id: "card-1" },
      "description",
    );
    expect(uploader.error()).toBe("Your organisation's storage is full. Ask an organisation admin to upgrade for more storage.");

    isOrgAdmin.set(true);
    await uploader.uploadAndInsert(
      new File(["hello"], "quota.txt", { type: "text/plain" }),
      null,
      { kind: "card", id: "card-1" },
      "description",
    );
    expect(uploader.error()).toBe("Your organisation's storage is full. Upgrade your plan to upload more files.");
  });

  it("shows upgrade guidance when a free-plan inline upload is too large", async () => {
    isOrgAdmin.set(true);
    isPlanLimited.set(true);
    api.request.mockRejectedValue(new ApiError(400, { code: "FILE_TOO_LARGE", maxFileBytes: 5 * 1024 * 1024 }));

    await uploader.uploadAndInsert(
      new File(["hello"], "large.png", { type: "image/png" }),
      null,
      { kind: "card", id: "card-1" },
      "description",
    );

    expect(uploader.error()).toBe("File is too large (max 5 MB). Upgrade your plan for higher file limits.");
  });

  it("posts note inline uploads to the note attachment endpoint", async () => {
    api.request.mockResolvedValueOnce({ id: "attachment-1", url: "/api/media/client-1/notes/note-1/file.txt" });

    await uploader.uploadAndInsert(
      new File(["hello"], "file.txt", { type: "text/plain" }),
      null,
      { kind: "note", id: "note-1" },
      "description",
    );

    expect(api.request).toHaveBeenCalledWith(
      "/notes/note-1/attachments?source=description",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    );
  });
});
