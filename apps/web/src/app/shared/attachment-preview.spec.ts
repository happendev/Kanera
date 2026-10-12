import { describe, expect, it } from "vitest";
import { attachmentPreviewType } from "./attachment-preview";

describe("attachmentPreviewType", () => {
  it("recognises Markdown MIME types and filename fallbacks", () => {
    expect(attachmentPreviewType("text/markdown", "plan.md")).toBe("markdown");
    expect(attachmentPreviewType("text/x-markdown", "plan.md")).toBe("markdown");
    expect(attachmentPreviewType("text/plain", "PLAN.MD")).toBe("markdown");
    expect(attachmentPreviewType("application/octet-stream", "output.markdown")).toBe("markdown");
  });

  it("previews plain text files as text, not Markdown", () => {
    expect(attachmentPreviewType("text/plain", "notes.txt")).toBe("text");
    expect(attachmentPreviewType("application/octet-stream", "server.LOG")).toBe("text");
    expect(attachmentPreviewType("text/csv", "export.csv")).toBeNull();
  });
});
