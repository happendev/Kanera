import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaDownloadService } from "./media-download.service";

describe("MediaDownloadService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("downloads a fetched blob with the requested filename and revokes its URL", async () => {
    const blob = new Blob(["media"], { type: "application/octet-stream" });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(blob))));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:download");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    await TestBed.inject(MediaDownloadService).download("/media/file", "file.bin");

    expect(click).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });

  it("falls back to the original URL when blob fetching fails", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    await TestBed.inject(MediaDownloadService).download("/media/file", "file.bin");

    expect(click).toHaveBeenCalledTimes(1);
    const downloadAnchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(downloadAnchor.getAttribute("href")).toBe("/media/file");
    expect(downloadAnchor.download).toBe("file.bin");
  });
});
