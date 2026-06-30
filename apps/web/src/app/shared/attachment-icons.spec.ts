import { describe, expect, it } from "vitest";
import { attachmentIconClass } from "./attachment-icons";

describe("attachmentIconClass", () => {
  it("uses MIME type when it identifies a known attachment kind", () => {
    expect(attachmentIconClass("application/pdf", "download")).toBe("ti-file-type-pdf");
    expect(attachmentIconClass("video/mp4", "clip.bin")).toBe("ti-video");
    expect(attachmentIconClass("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "report.bin")).toBe("ti-file-type-xls");
  });

  it("falls back to the file extension when MIME type is generic", () => {
    expect(attachmentIconClass("application/octet-stream", "notes.docx")).toBe("ti-file-type-doc");
    expect(attachmentIconClass("application/octet-stream", "archive.zip")).toBe("ti-file-zip");
    expect(attachmentIconClass("application/octet-stream", "config.json")).toBe("ti-file-code");
  });

  it("uses the generic file icon when no specific kind matches", () => {
    expect(attachmentIconClass("application/octet-stream", "blob.bin")).toBe("ti-file");
  });
});
