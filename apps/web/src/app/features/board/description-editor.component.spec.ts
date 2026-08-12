import { provideZonelessChangeDetection } from "@angular/core";
import type { ComponentFixture} from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { UnsavedWorkService } from "../../core/browser/unsaved-work.service";
import { DescriptionEditorComponent } from "./description-editor.component";

describe("DescriptionEditorComponent", () => {
  let api: { request: ReturnType<typeof vi.fn> };
  let fixture: ComponentFixture<DescriptionEditorComponent>;
  let uploadAndInsert: ReturnType<typeof vi.fn>;
  let attachmentIdsSnapshot: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    api = { request: vi.fn() };
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => document.body),
    });

    await TestBed.configureTestingModule({
      imports: [DescriptionEditorComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DescriptionEditorComponent);
    fixture.componentRef.setInput("value", "");
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("autofocus", false);
    fixture.detectChanges();
    if (fixture.componentInstance.editor) {
      fixture.componentInstance.editor.view.coordsAtPos = vi.fn(() => ({
        left: 10,
        right: 12,
        top: 10,
        bottom: 24,
      })) as typeof fixture.componentInstance.editor.view.coordsAtPos;
    }

    const uploader = (fixture.componentInstance as unknown as {
      uploader: {
        uploadAndInsert: typeof uploadAndInsert;
        attachmentIdsSnapshot: typeof attachmentIdsSnapshot;
      };
    }).uploader;
    uploadAndInsert = vi.fn();
    attachmentIdsSnapshot = vi.fn(() => []);
    uploader.uploadAndInsert = uploadAndInsert;
    uploader.attachmentIdsSnapshot = attachmentIdsSnapshot;
  });

  const sources = ["description", "comment"] as const;

  it("tracks edited content as unsaved until it is reset", () => {
    const unsavedWork = TestBed.inject(UnsavedWorkService);

    expect(unsavedWork.hasUnsavedWork()).toBe(false);
    fixture.componentInstance.setMarkdown("Pending change");
    expect(unsavedWork.hasUnsavedWork()).toBe(true);

    fixture.componentInstance.reset();
    expect(unsavedWork.hasUnsavedWork()).toBe(false);
  });

  it("treats a recovered value that differs from its published baseline as unsaved", () => {
    fixture.destroy();
    fixture = TestBed.createComponent(DescriptionEditorComponent);
    fixture.componentRef.setInput("value", "Recovered draft");
    fixture.componentRef.setInput("unsavedBaseline", "Published description");
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("autofocus", false);
    fixture.detectChanges();

    expect(TestBed.inject(UnsavedWorkService).hasUnsavedWork()).toBe(true);
  });

  for (const source of sources) {
    describe(`${source} attachments`, () => {
      beforeEach(() => {
        fixture.componentRef.setInput("attachmentSource", source);
        fixture.detectChanges();
      });

      it("uploads files chosen from the file picker", () => {
        const file = imageFile();
        fixture.componentInstance.onFileChosen({
          target: {
            files: [file],
            value: "C:\\fakepath\\screenshot.png",
          },
        } as unknown as Event);

        expectUpload(source, file);
      });

      it("uploads pasted files exposed through clipboard items", () => {
        const file = imageFile();
        const event = pasteEvent({ items: [clipboardFileItem(file)], files: [] });

        editorDom().dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expectUpload(source, file);
      });

      it("uploads pasted files exposed only through clipboard files", () => {
        const file = imageFile();
        const event = pasteEvent({ items: [], files: [file] });

        editorDom().dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expectUpload(source, file);
      });

      it("does not upload unsupported pasted files", () => {
        const file = new File(["html"], "page.html", { type: "text/html" });
        const event = pasteEvent({ items: [clipboardFileItem(file)], files: [file] });

        editorDom().dispatchEvent(event);

        expect(event.defaultPrevented).toBe(false);
        expect(uploadAndInsert).not.toHaveBeenCalled();
      });

      it("allows regular text paste to continue", () => {
        const event = pasteEvent({ items: [clipboardTextItem()], files: [] });

        editorDom().dispatchEvent(event);

        expect(event.defaultPrevented).toBe(false);
        expect(uploadAndInsert).not.toHaveBeenCalled();
      });

      it("preserves a pasted raw markdown table so it saves as renderable markdown", () => {
        const table = [
          "| Item              | In Stock | Price |",
          "| :---------------- | :------: | ----: |",
          "| Python Hat        |   True   | 23.99 |",
          "| SQL Hat           |   True   | 23.99 |",
          "| Codecademy Tee    |  False   | 19.99 |",
          "| Codecademy Hoodie |  False   | 42.99 |",
        ].join("\n");
        const event = pasteEvent({ items: [clipboardTextItem()], files: [], text: table });

        editorDom().dispatchEvent(event);
        fixture.detectChanges();

        expect(event.defaultPrevented).toBe(true);
        expect(uploadAndInsert).not.toHaveBeenCalled();
        expect(root().querySelector(".ProseMirror table")).not.toBeNull();
        expect(fixture.componentInstance.markdown()).toContain("| Item | In Stock | Price |");
        expect(fixture.componentInstance.markdown()).toContain("| Python Hat | True | 23.99 |");
        expect(fixture.componentInstance.markdown()).not.toContain("```");
      });

      it("renders pasted markdown documents instead of treating them as code", () => {
        const document = [
          "# Copy-to-board: bulk support + cross-org editor targets",
          "",
          "## Context",
          "",
          "Two gaps in the \"copy card to board\" feature:",
          "",
          "1. **No bulk copy-to-board.** The single-card right-click menu has \"Copy to board...\" (board picker -> `POST /cards/:id/duplicate` with `{ boardId }`), but the multi-select bulk menu ([bulk-card-actions-menu.popover.ts](apps/web/src/app/features/board/bulk-card-actions-menu.popover.ts)) only offers same-board \"Duplicate cards\". Users want to select multiple cards and copy them to another board.",
          "",
          "",
          "---",
        ].join("\n");
        const event = pasteEvent({ items: [clipboardTextItem()], files: [], text: document });

        editorDom().dispatchEvent(event);
        fixture.detectChanges();

        const markdown = fixture.componentInstance.markdown();
        expect(event.defaultPrevented).toBe(true);
        expect(uploadAndInsert).not.toHaveBeenCalled();
        expect(root().querySelector(".ProseMirror h1")?.textContent).toBe("Copy-to-board: bulk support + cross-org editor targets");
        expect(root().querySelector(".ProseMirror h2")?.textContent).toBe("Context");
        expect(root().querySelector(".ProseMirror pre")).toBeNull();
        expect(markdown).toContain("# Copy-to-board: bulk support + cross-org editor targets");
        expect(markdown).toContain("## Context");
        expect(markdown).toContain("1. **No bulk copy-to-board.**");
        expect(markdown).toContain("`POST /cards/:id/duplicate`");
        expect(markdown).toContain("[bulk-card-actions-menu.popover.ts](apps/web/src/app/features/board/bulk-card-actions-menu.popover.ts)");
        expect(markdown).toContain("---");
        expect(markdown).not.toContain("```");
      });

      it("leaves pasted fenced code blocks as code", () => {
        const code = [
          "```",
          "const value = price | fallback;",
          "return value;",
          "```",
        ].join("\n");
        const event = pasteEvent({ items: [clipboardTextItem()], files: [], text: code });

        editorDom().dispatchEvent(event);

        expect(uploadAndInsert).not.toHaveBeenCalled();
        expect(fixture.componentInstance.markdown()).toContain("```");
        expect(fixture.componentInstance.markdown()).toContain("const value = price | fallback;");
      });

      it("prevents file dragover so files can be dropped", () => {
        const event = dragEvent("dragover", { types: ["Files"], files: [] });

        editorDom().dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
      });

      it("uploads all supported dropped files", () => {
        const image = imageFile("screenshot.png");
        const text = new File(["notes"], "notes.txt", { type: "text/plain" });
        const event = dragEvent("drop", { types: ["Files"], files: [image, text] });

        editorDom().dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(uploadAndInsert).toHaveBeenCalledTimes(2);
        expectUpload(source, image, 0);
        expectUpload(source, text, 1);
      });

      it("does not upload unsupported dropped files", () => {
        const file = new File(["html"], "page.html", { type: "text/html" });
        const event = dragEvent("drop", { types: ["Files"], files: [file] });

        editorDom().dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(uploadAndInsert).not.toHaveBeenCalled();
      });

      it("includes uploaded attachment ids when saving", () => {
        attachmentIdsSnapshot.mockReturnValue(["attachment-1", "attachment-2"]);
        const saveSpy = vi.fn();
        fixture.componentInstance.save.subscribe(saveSpy);

        fixture.componentInstance.onSave();

        expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ attachmentIds: ["attachment-1", "attachment-2"] }));
      });
    });
  }

  it("inserts an emoji from the toolbar picker and saves Unicode markdown", async () => {
    const emojiButton = root().querySelector(".de-toolbar .ti-mood-smile")?.closest("button") as HTMLButtonElement;
    emojiButton.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const emoji = root().querySelector(".de-emoji-option") as HTMLButtonElement | null;
    expect(emoji).not.toBeNull();
    emoji?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    fixture.detectChanges();

    expect(fixture.componentInstance.markdown()).toMatch(/\p{Extended_Pictographic}/u);
  });

  it("emits markdown when content changes", async () => {
    const changeSpy = vi.fn();
    fixture.componentInstance.contentChange.subscribe(changeSpy);

    fixture.componentInstance.setMarkdown("Recovered draft");
    fixture.detectChanges();

    expect(changeSpy).toHaveBeenCalledWith("Recovered draft");
  });

  it("silently keeps validated fallback content without saving it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const editor = fixture.componentInstance.editor!;
    fixture.componentInstance.setMarkdown("Published description");
    const saveSpy = vi.fn();
    fixture.componentInstance.save.subscribe(saveSpy);
    const selectionBefore = editor.state.selection.from;

    editor.commands.insertContent({ type: "unsupportedNode" });
    fixture.detectChanges();

    expect(root().textContent).not.toContain("Some content could not be loaded");
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(selectionBefore);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(fixture.componentInstance.markdown()).toBe("Published description");
    expect(warn).toHaveBeenCalledWith(
      "[DescriptionEditor] Content validation failed.",
      expect.objectContaining({ source: "description", compact: false }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Published description");
    warn.mockRestore();
  });

  it("collapses select-all deletion to an editable empty paragraph", () => {
    fixture.componentInstance.setMarkdown("First paragraph\n\nSecond paragraph");
    const editor = fixture.componentInstance.editor!;
    editor.commands.selectAll();

    expect(() => editor.commands.deleteSelection()).not.toThrow();
    fixture.detectChanges();

    expect(editor.state.doc.textContent).toBe("");
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(1);
    expect(root().querySelector(".ProseMirror p")).not.toBeNull();
  });

  it("preserves intentional empty paragraphs through a Markdown save and reload", async () => {
    fixture.componentInstance.editor?.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        { type: "paragraph" },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "there" }] },
        { type: "paragraph" },
        { type: "paragraph" },
        { type: "paragraph" },
        { type: "horizontalRule" },
      ],
    });
    const blockShape = () => Array.from(editorDom().children).map((element) =>
      `${element.tagName}:${element.textContent ?? ""}`,
    );
    const beforeReload = blockShape();
    const saved = fixture.componentInstance.markdown();

    expect(saved.match(/&nbsp;/g)).toHaveLength(5);

    fixture.componentInstance.setMarkdown(saved);
    await fixture.whenStable();

    expect(beforeReload).toEqual([
      "P:hello",
      "P:",
      "P:",
      "P:there",
      "P:",
      "P:",
      "P:",
      "HR:",
      // TipTap's generated cursor landing after a terminal non-paragraph block.
      "P:",
    ]);
    expect(blockShape()).toEqual(beforeReload);
    expect(fixture.componentInstance.markdown()).toBe(saved);
  });

  it("pastes copied rich editor HTML without extra empty paragraphs", () => {
    fixture.componentInstance.setMarkdown("Alpha\n\n- One\n- Two\n\nOmega");
    const editor = fixture.componentInstance.editor!;
    editor.commands.selectAll();
    const copied = editor.view.serializeForClipboard(editor.state.selection.content());
    fixture.componentInstance.setMarkdown("");

    const event = pasteEvent({
      items: [clipboardTextItem()],
      files: [],
      text: copied.text,
      html: copied.dom.innerHTML,
    });
    editorDom().dispatchEvent(event);
    fixture.detectChanges();

    expect(fixture.componentInstance.markdown()).toBe("Alpha\n\n- One\n- Two\n\nOmega");
    expect(root().querySelectorAll(".ProseMirror > p:empty")).toHaveLength(0);
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }],
  ])("pastes text without formatting with %s+Shift+V", async (_modifier, modifier) => {
    editorDom().dispatchEvent(new KeyboardEvent("keydown", {
      key: "v",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      ...modifier,
    }));
    const event = pasteEvent({
      items: [clipboardTextItem()],
      files: [],
      text: "# Plain heading\n\n**Bold** and [linked](https://example.com)",
      html: '<h1>Plain heading</h1><p><strong>Bold</strong> and <a href="https://example.com">linked</a></p>',
    });

    editorDom().dispatchEvent(event);
    await fixture.whenStable();

    expect(event.defaultPrevented).toBe(true);
    expect(root().querySelector(".ProseMirror h1")).toBeNull();
    expect(root().querySelector(".ProseMirror strong")).toBeNull();
    expect(root().querySelector(".ProseMirror a")).toBeNull();
    expect(editorDom().textContent).toContain("# Plain heading");
    expect(editorDom().textContent).toContain("**Bold** and [linked](https://example.com)");
  });

  it.each([
    ["plain-text paste", false],
    ["Ctrl+Shift+V", true],
  ])("preserves every blank line during %s and after reload", async (_pasteKind, useShortcut) => {
    if (useShortcut) {
      editorDom().dispatchEvent(new KeyboardEvent("keydown", {
        key: "v",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    }
    const event = pasteEvent({
      items: [clipboardTextItem()],
      files: [],
      text: "Alpha\n\n\nBeta\n\nGamma",
    });

    editorDom().dispatchEvent(event);
    await fixture.whenStable();

    const blockShape = () => Array.from(editorDom().children).map((element) =>
      `${element.tagName}:${element.textContent ?? ""}`,
    );
    expect(event.defaultPrevented).toBe(true);
    expect(blockShape()).toEqual(["P:Alpha", "P:", "P:", "P:Beta", "P:", "P:Gamma"]);

    const saved = fixture.componentInstance.markdown();
    expect(saved.match(/&nbsp;/g)).toHaveLength(3);
    fixture.componentInstance.setMarkdown(saved);
    await fixture.whenStable();

    expect(blockShape()).toEqual(["P:Alpha", "P:", "P:", "P:Beta", "P:", "P:Gamma"]);
  });

  it.each([
    ["Google Docs", '<meta charset="utf-8"><p><b>Launch plan</b></p><p>Review owners</p>'],
    ["Word", '<p class="MsoNormal"><strong>Launch plan</strong></p><p class="MsoNormal">Review owners</p>'],
    ["Slack", '<div><strong>Launch plan</strong></div><div>Review owners</div>'],
    ["GitHub", '<p><strong>Launch plan</strong></p><ul><li>Review owners</li></ul>'],
  ])("pastes %s-style HTML without doubled boundary paragraphs", (_source, html) => {
    const event = pasteEvent({
      items: [clipboardTextItem()],
      files: [],
      text: "Launch plan\nReview owners",
      html,
    });

    editorDom().dispatchEvent(event);
    fixture.detectChanges();

    const markdown = fixture.componentInstance.markdown();
    expect(markdown).toContain("Launch plan");
    expect(markdown).toContain("Review owners");
    expect(markdown).not.toMatch(/^\n|\n$/);
    expect(markdown).not.toContain("\n\n\n");
  });

  it("drops unsafe pasted HTML and data images", () => {
    const event = pasteEvent({
      items: [clipboardTextItem()],
      files: [],
      text: "Safe text",
      html: '<p>Safe text</p><script>alert("unsafe")</script><img src="data:image/png;base64,AAAA">',
    });

    editorDom().dispatchEvent(event);
    fixture.detectChanges();

    expect(root().querySelector(".ProseMirror script")).toBeNull();
    expect(root().querySelector(".ProseMirror img")).toBeNull();
    expect(fixture.componentInstance.markdown()).toBe("Safe text");
  });

  it("starts a code block when three backticks are typed at the start of a line", () => {
    typeText("```");
    fixture.detectChanges();

    expect(root().querySelector(".ProseMirror pre")).not.toBeNull();
    expect(fixture.componentInstance.editor?.isActive("codeBlock")).toBe(true);
    expect(fixture.componentInstance.markdown()).toBe("```\n```");
  });

  it("undoes immediate three-backtick conversion in one step", () => {
    typeText("```");
    expect(fixture.componentInstance.editor?.isActive("codeBlock")).toBe(true);

    fixture.componentInstance.editor?.commands.undo();
    fixture.detectChanges();

    expect(fixture.componentInstance.editor?.isActive("codeBlock")).toBe(false);
    expect(fixture.componentInstance.editor?.state.doc.firstChild?.type.name).toBe("paragraph");
  });

  it("creates an editable paragraph above a leading code block on ArrowUp", () => {
    fixture.componentInstance.setMarkdown("```\nconst ready = true;\n```");
    const editor = fixture.componentInstance.editor!;
    editor.commands.setTextSelection(1);
    // jsdom has no text layout rectangles; keep the unrelated gap-cursor
    // shortcut from asking the DOM for vertical cursor geometry.
    editor.view.endOfTextblock = vi.fn(() => false);

    expect(editor.commands.keyboardShortcut("ArrowUp")).toBe(true);
    fixture.detectChanges();

    expect(fixture.componentInstance.editor?.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(fixture.componentInstance.editor?.state.doc.child(1).type.name).toBe("codeBlock");
  });

  it("indents code with Tab without moving focus", () => {
    fixture.componentInstance.setMarkdown("```\nconst ready = true;\n```");
    const editor = fixture.componentInstance.editor!;
    editor.commands.setTextSelection(textPosition("const") - 1);
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });

    editorDom().dispatchEvent(event);
    fixture.detectChanges();

    expect(event.defaultPrevented).toBe(true);
    expect(fixture.componentInstance.markdown()).toContain("    const ready = true;");
    expect(fixture.componentInstance.editor?.isActive("codeBlock")).toBe(true);
  });

  it("turns an empty code block into a paragraph on Backspace", () => {
    fixture.componentInstance.setMarkdown("```\n\n```");
    const editor = fixture.componentInstance.editor!;
    editor.commands.setTextSelection(1);

    expect(editor.commands.keyboardShortcut("Backspace")).toBe(true);
    fixture.detectChanges();

    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
  });

  it("exits a code block after its double-newline boundary", () => {
    fixture.componentInstance.setMarkdown("```\nconst ready = true;\n\n\n```");
    const editor = fixture.componentInstance.editor!;
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);
    fixture.detectChanges();

    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
  });

  it("preserves Shift+Enter hard breaks after save and reopen", () => {
    fixture.componentInstance.setMarkdown("First lineSecond line");
    fixture.componentInstance.editor?.commands.setTextSelection(textPosition("Second line") - 1);
    editorDom().dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    fixture.detectChanges();

    const saved = fixture.componentInstance.markdown();
    expect(root().querySelector(".ProseMirror br")).not.toBeNull();
    fixture.componentInstance.setMarkdown(saved);
    fixture.detectChanges();

    expect(root().querySelector(".ProseMirror br")).not.toBeNull();
    expect(fixture.componentInstance.markdown()).toBe(saved);
  });

  it("creates one code block from a multi-paragraph toolbar selection", () => {
    fixture.componentInstance.setMarkdown("const first = 1;\n\nconst second = 2;");
    fixture.componentInstance.editor?.commands.selectAll();
    fixture.detectChanges();

    const codeBlockButton = root().querySelector(".de-toolbar .ti-source-code")?.closest("button") as HTMLButtonElement;
    codeBlockButton.click();
    fixture.detectChanges();

    expect(root().querySelectorAll(".ProseMirror pre")).toHaveLength(1);
    expect(fixture.componentInstance.markdown()).toBe([
      "```",
      "const first = 1;",
      "const second = 2;",
      "```",
    ].join("\n"));
  });

  it("keeps horizontal rules rendered after saving and reopening", () => {
    const markdown = [
      "Before",
      "",
      "---",
      "",
      "Between",
      "",
      "---",
      "",
      "After",
    ].join("\n");

    fixture.componentInstance.setMarkdown(markdown);
    fixture.detectChanges();

    expect(root().querySelectorAll(".ProseMirror hr")).toHaveLength(2);

    const savedMarkdown = fixture.componentInstance.markdown();
    fixture.destroy();
    fixture = TestBed.createComponent(DescriptionEditorComponent);
    fixture.componentRef.setInput("value", savedMarkdown);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("autofocus", false);
    fixture.detectChanges();

    expect(savedMarkdown).toBe(markdown);
    expect(root().querySelectorAll(".ProseMirror hr")).toHaveLength(2);
    expect(root().querySelector(".ProseMirror")?.textContent).toContain("Before");
    expect(root().querySelector(".ProseMirror")?.textContent).toContain("Between");
    expect(root().querySelector(".ProseMirror")?.textContent).toContain("After");
  });

  it("keeps an existing markdown table structured after reopening and editing", () => {
    const table = [
      "| Status | Owner |",
      "|---|---|",
      "| Ready | Ada |",
    ].join("\n");

    fixture.componentInstance.setMarkdown(table);
    fixture.detectChanges();
    fixture.componentInstance.editor?.commands.setTextSelection(textPosition("Ready") - 1);
    fixture.componentInstance.editor?.commands.insertContent("Almost ");
    fixture.detectChanges();

    const markdown = fixture.componentInstance.markdown();
    expect(root().querySelector(".ProseMirror table")).not.toBeNull();
    expect(markdown).toContain("| Status | Owner |");
    expect(markdown).toMatch(/\|\s*---\s*\|\s*---\s*\|/);
    expect(markdown).toContain("| Almost Ready | Ada |");
    expect(markdown).not.toContain("```");
  });

  it("separates saved markdown tables from surrounding paragraphs", () => {
    fixture.componentInstance.setMarkdown([
      "Before",
      "",
      "| Status | Owner |",
      "|---|---|",
      "| Ready | Ada |",
      "",
      "After",
    ].join("\n"));
    fixture.detectChanges();

    const markdown = fixture.componentInstance.markdown();
    expect(markdown).toContain("Before\n\n| Status | Owner |");
    expect(markdown).toContain("| Ready | Ada |\n\nAfter");
  });

  it("fills empty inserted table cells with editable paragraphs", () => {
    expect(() => fixture.componentInstance.editor?.commands.insertTable({
      rows: 2,
      cols: 2,
      withHeaderRow: true,
    })).not.toThrow();
    fixture.detectChanges();

    const cells = root().querySelectorAll(".ProseMirror th, .ProseMirror td");
    expect(cells).toHaveLength(4);
    expect([...cells].every((cell) => cell.firstElementChild?.tagName === "P")).toBe(true);
  });

  it("round-trips multiple blocks, hard breaks, and escaped pipes in table cells", () => {
    fixture.componentInstance.editor?.commands.setContent({
      type: "doc",
      content: [{
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Status" }] }] },
              { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Owner" }] }] },
            ],
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "Ready | blocked" }] },
                  { type: "paragraph", content: [{ type: "text", text: "Needs review" }] },
                ],
              },
              {
                type: "tableCell",
                content: [{
                  type: "paragraph",
                  content: [{ type: "text", text: "Ada" }, { type: "hardBreak" }, { type: "text", text: "Grace" }],
                }],
              },
            ],
          },
        ],
      }],
    });
    fixture.detectChanges();

    const saved = fixture.componentInstance.markdown();
    expect(saved).toContain("Ready \\| blocked<br>Needs review");
    expect(saved).toContain("Ada<br>Grace");
    fixture.componentInstance.setMarkdown(saved);
    fixture.detectChanges();

    expect(root().querySelector(".ProseMirror table")).not.toBeNull();
    expect(fixture.componentInstance.markdown()).toContain("Ready \\| blocked");
  });

  it("keeps the Kanera Markdown compatibility corpus stable", () => {
    const corpus = [
      "@[Ada Lovelace](kanera-user:123e4567-e89b-12d3-a456-426614174000) and [release](https://example.com/release)",
      "",
      "- Parent",
      "  1. Nested numbered",
      "     - [ ] Nested task",
      "",
      "| Value | Owner |",
      "|---|---|",
      "| A \\| B<br>Second block | Ada |",
      "",
      "```md",
      "# This remains code",
      "- [ ] not a task",
      "```",
      "",
      "---",
      "",
      "![Diagram](https://example.com/diagram.png)",
      "",
      "Emoji :rocket:",
    ].join("\n");

    fixture.componentInstance.setMarkdown(corpus);
    fixture.detectChanges();
    const saved = fixture.componentInstance.markdown();
    fixture.componentInstance.setMarkdown(saved);
    fixture.detectChanges();

    expect(saved).toContain("@[Ada Lovelace](kanera-user:123e4567-e89b-12d3-a456-426614174000)");
    expect(saved).toContain("[release](https://example.com/release)");
    expect(saved).toContain("- [ ] Nested task");
    expect(saved).toContain("A \\| B<br>Second block");
    expect(saved).toContain("# This remains code");
    expect(saved).toContain("---");
    expect(saved).toContain("![Diagram](https://example.com/diagram.png)");
    expect(saved).toContain("🚀");
    expect(fixture.componentInstance.markdown()).toBe(saved);
  });

  it("persists image attribute updates to Markdown", () => {
    fixture.componentInstance.setMarkdown("![Original](https://example.com/image.png)");
    const editor = fixture.componentInstance.editor!;
    let imagePos = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== "image") return true;
      imagePos = pos;
      return false;
    });
    editor.commands.setNodeSelection(imagePos);
    editor.commands.updateAttributes("image", { alt: "Updated diagram", title: "Release" });
    fixture.detectChanges();

    expect(fixture.componentInstance.markdown()).toContain('![Updated diagram](https://example.com/image.png "Release")');
  });

  it("keeps markdown task lists structured after reopening and editing", () => {
    fixture.componentInstance.setMarkdown("- [ ] Draft release note\n- [x] Ship fix");
    fixture.detectChanges();
    fixture.componentInstance.editor?.commands.setTextSelection(textPosition("Draft") - 1);
    fixture.componentInstance.editor?.commands.insertContent("Write ");
    fixture.detectChanges();

    const markdown = fixture.componentInstance.markdown();
    expect(root().querySelector(".ProseMirror ul[data-type='taskList']")).not.toBeNull();
    const taskItems = root().querySelectorAll<HTMLElement>(".ProseMirror li[data-type='taskItem']");
    expect(taskItems).toHaveLength(2);
    expect(getComputedStyle(taskItems[0]!).display).toBe("flex");
    expect(markdown).toContain("- [ ] Write Draft release note");
    expect(markdown).toContain("- [x] Ship fix");

    const checkbox = taskItems[0]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    checkbox.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.markdown()).toContain("- [x] Write Draft release note");
  });

  it("does not serialize an empty task item as visible checkbox text", () => {
    fixture.componentInstance.editor?.chain().focus().toggleTaskList().run();
    fixture.detectChanges();

    expect(root().querySelector(".ProseMirror li[data-type='taskItem']")).not.toBeNull();
    expect(fixture.componentInstance.markdown()).toBe("");
  });

  it("keeps durable markdown links and mentions after reopening", () => {
    fixture.componentInstance.setMarkdown([
      "@[Ada Lovelace](kanera-user:123e4567-e89b-12d3-a456-426614174000) wrote:",
      "",
      "[Release plan](https://example.com/release)",
    ].join("\n"));
    fixture.detectChanges();

    const markdown = fixture.componentInstance.markdown();
    expect(markdown).toContain("@[Ada Lovelace](kanera-user:123e4567-e89b-12d3-a456-426614174000)");
    expect(markdown).toContain("[Release plan](https://example.com/release)");
    expect(markdown).not.toContain("&lt;a");
  });

  it("keeps text typed at the end of a reopened mention outside the mention link", () => {
    fixture.componentInstance.setMarkdown(
      "@[Ada Lovelace](kanera-user:123e4567-e89b-12d3-a456-426614174000)",
    );
    fixture.detectChanges();
    fixture.componentInstance.editor?.commands.setTextSelection(textPosition("Ada Lovelace") + "Ada Lovelace".length);

    typeText(" followed up");
    fixture.detectChanges();

    expect(fixture.componentInstance.markdown()).toBe(
      "@[Ada Lovelace](kanera-user:123e4567-e89b-12d3-a456-426614174000) followed up",
    );
  });

  it("lets the emoji picker search input receive focus and filter results", async () => {
    const emojiButton = root().querySelector(".de-toolbar .ti-mood-smile")?.closest("button") as HTMLButtonElement;
    emojiButton.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const input = root().querySelector(".de-emoji-search input") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    input?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    input?.focus();
    expect(document.activeElement).toBe(input);

    input!.value = "rocket";
    input?.dispatchEvent(new Event("input", { bubbles: true }));
    fixture.detectChanges();

    expect(fixture.componentInstance.emojiQuery()).toBe("rocket");
    expect([...root().querySelectorAll(".de-emoji-option")].some((option) => option.textContent?.includes("🚀"))).toBe(true);
  });

  it("inserts text-default symbols with emoji presentation", async () => {
    const emojiButton = root().querySelector(".de-toolbar .ti-mood-smile")?.closest("button") as HTMLButtonElement;
    emojiButton.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const input = root().querySelector(".de-emoji-search input") as HTMLInputElement;
    input.value = "transgender";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    fixture.detectChanges();

    const symbol = [...root().querySelectorAll<HTMLButtonElement>(".de-emoji-option")]
      .find((option) => option.textContent?.includes("⚧️"));
    expect(symbol).toBeDefined();
    symbol?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    fixture.detectChanges();

    expect(fixture.componentInstance.markdown()).toContain("⚧️");
  });

  it("closes the emoji picker when clicking outside it", async () => {
    const emojiButton = root().querySelector(".de-toolbar .ti-mood-smile")?.closest("button") as HTMLButtonElement;
    emojiButton.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(root().querySelector(".de-emoji-popover")).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    fixture.detectChanges();

    expect(root().querySelector(".de-emoji-popover")).toBeNull();
    expect(fixture.componentInstance.emojiOpen()).toBe(false);
  });

  it("closes the emoji picker from its close button", async () => {
    const emojiButton = root().querySelector(".de-toolbar .ti-mood-smile")?.closest("button") as HTMLButtonElement;
    emojiButton.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const closeButton = root().querySelector(".de-emoji-close") as HTMLButtonElement | null;
    expect(closeButton).not.toBeNull();

    closeButton?.click();
    fixture.detectChanges();

    expect(root().querySelector(".de-emoji-popover")).toBeNull();
    expect(fixture.componentInstance.emojiOpen()).toBe(false);
  });

  it("shows the compact emoji button and inserts emojis there too", async () => {
    fixture.componentRef.setInput("compact", true);
    fixture.detectChanges();

    const emojiButton = root().querySelector(".de-compact-footer .ti-mood-smile")?.closest("button") as HTMLButtonElement;
    expect(emojiButton).not.toBeNull();
    emojiButton.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const emoji = root().querySelector(".de-emoji-option") as HTMLButtonElement | null;
    expect(emoji).not.toBeNull();
    emoji?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    fixture.detectChanges();

    expect(fixture.componentInstance.markdown()).toMatch(/\p{Extended_Pictographic}/u);
  });

  it("shows a bubble formatting menu for compact editors when text is selected", () => {
    fixture.componentRef.setInput("compact", true);
    fixture.componentInstance.editor?.commands.setContent("Format this");
    fixture.detectChanges();

    fixture.componentInstance.editor?.commands.setTextSelection({ from: 1, to: 7 });
    fixture.detectChanges();

    expect(root().querySelector(".de-bubble-menu")).not.toBeNull();
    expect(root().querySelector(".de-bubble-menu .ti-bold")).not.toBeNull();
  });

  it("does not dismiss the compact formatting menu on the selection click inside the editor", () => {
    fixture.componentRef.setInput("compact", true);
    fixture.componentInstance.editor?.commands.setContent("Format this");
    fixture.componentInstance.editor?.commands.setTextSelection({ from: 1, to: 7 });
    fixture.detectChanges();

    editorDom().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    fixture.detectChanges();

    expect(root().querySelector(".de-bubble-menu")).not.toBeNull();
    expect(fixture.componentInstance.bubbleMenuOpen()).toBe(true);
  });

  it("keeps the bubble formatting menu hidden for full description editors", () => {
    fixture.componentInstance.editor?.commands.setContent("Format this");
    fixture.componentInstance.editor?.commands.setTextSelection({ from: 1, to: 7 });
    fixture.detectChanges();

    expect(root().querySelector(".de-bubble-menu")).toBeNull();
    expect(root().querySelector(".de-toolbar .ti-bold")).not.toBeNull();
    expect(root().querySelector(".de-toolbar .ti-list-check")).not.toBeNull();
  });

  it("inserts an emoji from colon autocomplete as Unicode markdown", () => {
    fixture.componentInstance.editor?.commands.insertContent(":thumbs");
    fixture.detectChanges();

    expect(root().querySelector(".de-emoji-popover")).not.toBeNull();
    const thumbs = [...root().querySelectorAll<HTMLButtonElement>(".de-emoji-option")].find((option) => option.textContent?.includes("👍")) ?? null;
    expect(thumbs).not.toBeNull();
    thumbs?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    fixture.detectChanges();

    expect(fixture.componentInstance.markdown()).toContain("👍");
    expect(fixture.componentInstance.markdown()).not.toContain(":thumbsup:");
  });

  it("keeps mention autocomplete working alongside emoji autocomplete", () => {
    fixture.componentRef.setInput("mentionMembers", [
      {
        userId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "Ada Lovelace",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
    ]);
    fixture.detectChanges();

    fixture.componentInstance.editor?.commands.insertContent("@Ada");
    fixture.detectChanges();

    const mention = root().querySelector(".de-mention-option") as HTMLButtonElement | null;
    expect(mention).not.toBeNull();
    mention?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    fixture.detectChanges();

    expect(fixture.componentInstance.markdown()).toContain("@[Ada Lovelace](kanera-user:123e4567-e89b-12d3-a456-426614174000)");
  });

  it("caps mention autocomplete height when flipped above the trigger", () => {
    fixture.componentRef.setInput("mentionMembers", [
      {
        userId: "123e4567-e89b-12d3-a456-426614174001",
        displayName: "Grace Hopper",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
      {
        userId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "Ada Lovelace",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
      {
        userId: "123e4567-e89b-12d3-a456-426614174002",
        displayName: "Amelia Hart",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
      {
        userId: "123e4567-e89b-12d3-a456-426614174003",
        displayName: "Marcus Cole",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
      {
        userId: "123e4567-e89b-12d3-a456-426614174004",
        displayName: "Nina Park",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
      {
        userId: "123e4567-e89b-12d3-a456-426614174005",
        displayName: "Omar Ibrahim",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
      {
        userId: "123e4567-e89b-12d3-a456-426614174006",
        displayName: "Priya Nair",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
      {
        userId: "123e4567-e89b-12d3-a456-426614174007",
        displayName: "Theo Banks",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
    ]);
    fixture.detectChanges();

    const coordsAtPos = fixture.componentInstance.editor?.view.coordsAtPos as ReturnType<typeof vi.fn>;
    coordsAtPos.mockReturnValue({ left: 10, right: 12, top: 180, bottom: 194 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 300 });
    fixture.componentInstance.editor?.commands.insertContent("@");
    fixture.detectChanges();

    const popover = root().querySelector(".de-mention-popover") as HTMLElement | null;
    expect(popover).not.toBeNull();
    expect(coordsAtPos).toHaveBeenLastCalledWith(2, -1);
    expect(popover?.style.getPropertyValue("--ap-top")).toBe("6px");
    expect(popover?.style.getPropertyValue("--ap-max-height")).toBe("170px");
  });

  it("keeps tall filtered mention autocomplete stable when flipped above the trigger", () => {
    fixture.componentRef.setInput("mentionMembers", [
      {
        userId: "123e4567-e89b-12d3-a456-426614174001",
        displayName: "Amelia Hart",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
      {
        userId: "123e4567-e89b-12d3-a456-426614174002",
        displayName: "Avery Cole",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
      {
        userId: "123e4567-e89b-12d3-a456-426614174003",
        displayName: "Alice Park",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
      {
        userId: "123e4567-e89b-12d3-a456-426614174004",
        displayName: "Aaron Bell",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
      {
        userId: "123e4567-e89b-12d3-a456-426614174005",
        displayName: "Anika Rao",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
      {
        userId: "123e4567-e89b-12d3-a456-426614174006",
        displayName: "April Lane",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
      {
        userId: "123e4567-e89b-12d3-a456-426614174007",
        displayName: "Adam Stone",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
    ]);
    fixture.detectChanges();

    const coordsAtPos = fixture.componentInstance.editor?.view.coordsAtPos as ReturnType<typeof vi.fn>;
    coordsAtPos.mockReturnValue({ left: 10, right: 12, top: 360, bottom: 374 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
    fixture.componentInstance.editor?.commands.insertContent("@a");
    fixture.detectChanges();

    const popover = root().querySelector(".de-mention-popover") as HTMLElement | null;
    expect(popover).not.toBeNull();
    expect(popover?.style.getPropertyValue("--ap-top")).toBe("116px");
  });

  it("indents bullet list items on Tab", () => {
    setTwoItemBulletList();
    fixture.componentInstance.editor?.commands.setTextSelection(textPosition("Child"));
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });

    editorDom().dispatchEvent(event);
    fixture.detectChanges();

    expect(event.defaultPrevented).toBe(true);
    expect(fixture.componentInstance.markdown()).toContain("  - Child");
    expect(document.activeElement).not.toBe(root().querySelector(".de-actions .ghost"));
  });

  it("outdents bullet list items on Shift+Tab", () => {
    setTwoItemBulletList();
    fixture.componentInstance.editor?.commands.setTextSelection(textPosition("Child"));
    editorDom().dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    fixture.componentInstance.editor?.commands.setTextSelection(textPosition("Child"));
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });

    editorDom().dispatchEvent(event);
    fixture.detectChanges();

    expect(event.defaultPrevented).toBe(true);
    expect(fixture.componentInstance.markdown()).toContain("- Parent\n- Child");
  });

  function editorDom(): HTMLElement {
    return root().querySelector(".ProseMirror") as HTMLElement;
  }

  function typeText(text: string) {
    const editor = fixture.componentInstance.editor;
    if (!editor) throw new Error("Editor is not mounted");
    for (const character of text) {
      const { from, to } = editor.state.selection;
      let handled = false;
      editor.view.someProp("handleTextInput", (handler) => {
        if (!handler(editor.view, from, to, character, () => editor.state.tr.insertText(character, from, to))) return false;
        handled = true;
        return true;
      });
      if (!handled) editor.view.dispatch(editor.state.tr.insertText(character, from, to));
    }
  }

  function setTwoItemBulletList() {
    fixture.componentInstance.editor?.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Parent" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Child" }] }] },
          ],
        },
      ],
    });
  }

  function textPosition(text: string): number {
    let found: number | null = null;
    fixture.componentInstance.editor?.state.doc.descendants((node, pos) => {
      const index = node.text?.indexOf(text) ?? -1;
      if (index < 0) return true;
      found = pos + index + 1;
      return false;
    });
    if (found === null) throw new Error(`Could not find editor text "${text}"`);
    return found;
  }

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function imageFile(name = "screenshot.png"): File {
    return new File(["image"], name, { type: "image/png" });
  }

  function clipboardFileItem(file: File): DataTransferItem {
    return {
      kind: "file",
      type: file.type,
      getAsFile: () => file,
    } as DataTransferItem;
  }

  function clipboardTextItem(): DataTransferItem {
    return {
      kind: "string",
      type: "text/plain",
      getAsFile: () => null,
    } as DataTransferItem;
  }

  function pasteEvent(data: { items: DataTransferItem[]; files: File[]; text?: string; html?: string }): ClipboardEvent {
    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: data.items,
        files: data.files,
        getData: vi.fn((type: string) => {
          if (type === "text/plain") return data.text ?? "";
          if (type === "text/html") return data.html ?? "";
          return "";
        }),
      },
    });
    return event;
  }

  function dragEvent(type: "dragover" | "drop", data: { types: string[]; files: File[] }): DragEvent {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", {
      value: {
        types: data.types,
        files: data.files,
      },
    });
    return event;
  }

  function expectUpload(source: "description" | "comment", file: File, callIndex = 0) {
    expect(uploadAndInsert).toHaveBeenNthCalledWith(
      callIndex + 1,
      file,
      fixture.componentInstance.editor,
      { kind: "card", id: "card-1" },
      source,
    );
  }
});
