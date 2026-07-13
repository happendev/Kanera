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
          "| Kanera env var | Stripe Price configuration |",
          "|---|---|",
          "| `STRIPE_PRICE_ID_PRO_MONTHLY` | Recurring monthly per-seat Price |",
          "| `STRIPE_PRICE_ID_PRO_ANNUAL` | Recurring yearly per-seat Price |",
        ].join("\n");
        const event = pasteEvent({ items: [clipboardTextItem()], files: [], text: table });

        editorDom().dispatchEvent(event);
        fixture.detectChanges();

        expect(event.defaultPrevented).toBe(true);
        expect(uploadAndInsert).not.toHaveBeenCalled();
        expect(root().querySelector(".ProseMirror table")).not.toBeNull();
        expect(fixture.componentInstance.markdown()).toContain("| Kanera env var | Stripe Price configuration |");
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

  it("keeps markdown task lists structured after reopening and editing", () => {
    fixture.componentInstance.setMarkdown("- [ ] Draft release note\n- [x] Ship fix");
    fixture.detectChanges();
    fixture.componentInstance.editor?.commands.setTextSelection(textPosition("Draft") - 1);
    fixture.componentInstance.editor?.commands.insertContent("Write ");
    fixture.detectChanges();

    const markdown = fixture.componentInstance.markdown();
    expect(root().querySelector(".ProseMirror ul[data-type='taskList']")).not.toBeNull();
    expect(markdown).toContain("- [ ] Write Draft release note");
    expect(markdown).toContain("- [x] Ship fix");
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

  it("closes the emoji picker when clicking outside it", async () => {
    const emojiButton = root().querySelector(".de-toolbar .ti-mood-smile")?.closest("button") as HTMLButtonElement;
    emojiButton.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(root().querySelector(".de-emoji-popover")).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
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
    coordsAtPos.mockReturnValue({ left: 10, right: 12, top: 120, bottom: 134 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 300 });
    fixture.componentInstance.editor?.commands.insertContent("@");
    fixture.detectChanges();

    const popover = root().querySelector(".de-mention-popover") as HTMLElement | null;
    expect(popover).not.toBeNull();
    expect(coordsAtPos).toHaveBeenLastCalledWith(2, -1);
    expect(fixture.componentInstance.mentionTop()).toBe(6);
    expect(fixture.componentInstance.mentionMaxHeight()).toBe(110);
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

    expect(root().querySelector(".de-mention-popover")).not.toBeNull();
    expect(fixture.componentInstance.mentionTop()).toBe(116);
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

  function pasteEvent(data: { items: DataTransferItem[]; files: File[]; text?: string }): ClipboardEvent {
    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: data.items,
        files: data.files,
        getData: vi.fn((type: string) => type === "text/plain" ? data.text ?? "" : ""),
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
