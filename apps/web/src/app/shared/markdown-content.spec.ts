import { describe, expect, it } from "vitest";
import { hasMarkdownContent, stripEmptyTaskItems } from "./markdown-content";

describe("hasMarkdownContent", () => {
  it("treats absent, empty, and whitespace-only markdown as blank", () => {
    expect(hasMarkdownContent(null)).toBe(false);
    expect(hasMarkdownContent(undefined)).toBe(false);
    expect(hasMarkdownContent("")).toBe(false);
    expect(hasMarkdownContent("   \n\n\t\r\n  ")).toBe(false);
  });

  it("treats editor artefacts that render as nothing as blank", () => {
    // tiptap-markdown writes a line-ending backslash for each hard break.
    expect(hasMarkdownContent("\\\n\\\n")).toBe(false);
    expect(hasMarkdownContent("<br><br/>")).toBe(false);
    expect(hasMarkdownContent("&nbsp; ")).toBe(false);
    expect(hasMarkdownContent("&#160;&#x20;")).toBe(false);
    expect(hasMarkdownContent("​⁠﻿")).toBe(false);
    expect(hasMarkdownContent("- [ ]")).toBe(false);
    expect(hasMarkdownContent("* [x]  ")).toBe(false);
  });

  it("reports content for anything visible", () => {
    expect(hasMarkdownContent("Hello")).toBe(true);
    expect(hasMarkdownContent("\n\n  x  \n")).toBe(true);
    // A backslash the user typed is escaped by the serialiser, so one survives the hard-break strip.
    expect(hasMarkdownContent("\\\\")).toBe(true);
    expect(hasMarkdownContent("- [ ] todo")).toBe(true);
    expect(hasMarkdownContent("![img](kanera-attachment:1)")).toBe(true);
  });

  it("removes empty task rows without changing examples in fenced code", () => {
    expect(stripEmptyTaskItems("- [ ]\n- [x] Ship\n- [ ]   \n- [ ] Review")).toBe("- [x] Ship\n- [ ] Review");
    expect(stripEmptyTaskItems("```md\n- [ ]\n```\n\n- [ ]")).toBe("```md\n- [ ]\n```\n\n");
  });
});
