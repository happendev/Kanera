import { provideZonelessChangeDetection } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { CardComposerDialogComponent } from "./card-composer.dialog";

const LISTS = [
  { id: "list-1", name: "Doing", icon: null, color: null },
  { id: "list-2", name: "Done", icon: null, color: null },
];

describe("CardComposerDialogComponent", () => {
  let api: {
    createCard: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
  };
  let fixture: ComponentFixture<CardComposerDialogComponent>;

  async function create(inputs: Record<string, unknown> = {}) {
    fixture = TestBed.createComponent(CardComposerDialogComponent);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("lists", LISTS);
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.componentInstance;
  }

  beforeEach(async () => {
    localStorage.clear();
    api = {
      createCard: vi.fn(async () => ({ id: "card-1" })),
      put: vi.fn(async () => ({})),
      patch: vi.fn(async () => ({})),
      post: vi.fn(async () => ({})),
      request: vi.fn(async () => ({ id: "attachment-1", url: "/media/a.png" })),
    };
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => document.body),
    });

    await TestBed.configureTestingModule({
      imports: [CardComposerDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        { provide: NotificationsService, useValue: { watchCreatedCardLocally: vi.fn() } },
      ],
    }).compileComponents();
  });

  // The list menu's "Add card" inserts at the top of the lane and the lane-footer button at the
  // bottom. Both now open this dialog, so the flag has to survive the trip.
  it("sends the seeded insert position on create", async () => {
    const component = await create({ seed: { listId: "list-2", atTop: true } });
    component.setTitle("Top card");
    await component.submit();

    expect(api.createCard).toHaveBeenCalledWith(
      "/boards/board-1/lists/list-2/cards",
      expect.objectContaining({ title: "Top card", atTop: true }),
    );
  });

  it("omits the insert position when the affordance appends", async () => {
    const component = await create({ seed: { listId: "list-1" } });
    component.setTitle("Bottom card");
    await component.submit();

    expect(api.createCard).toHaveBeenCalledWith(
      "/boards/board-1/lists/list-1/cards",
      expect.not.objectContaining({ atTop: expect.anything() }),
    );
  });

  it("keeps a valid list selected when the restored one no longer exists", async () => {
    const component = await create({ seed: { listId: "deleted-list" } });
    expect(component.draft().listId).toBe("list-1");
  });

  // Attachments are card-scoped server-side, so the composer stages files locally and flushes them
  // once the create returns. jsdom has no DataTransfer, so the drag/clipboard payloads are minimal
  // stand-ins carrying only what the handlers read.
  describe("staged attachments", () => {
    const png = () => new File(["binary"], "shot.png", { type: "image/png" });
    const blocked = () => new File(["x"], "payload.exe", { type: "application/x-msdownload" });

    function transfer(files: File[]) {
      return {
        types: ["Files"],
        items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
        files,
      };
    }

    function pasteOf(files: File[]) {
      return { clipboardData: transfer(files), preventDefault: vi.fn() } as unknown as ClipboardEvent;
    }

    it("stages pasted files and rejects types the server would refuse", async () => {
      const component = await create();

      component.onPaste(pasteOf([png(), blocked()]));

      expect(component.pendingAttachments().map((item) => item.file.name)).toEqual(["shot.png"]);
      expect(component.attachmentError()).toContain("1 file skipped");
    });

    it("ignores a paste carrying no files so text paste still reaches the editor", async () => {
      const component = await create();
      const event = pasteOf([]);

      component.onPaste(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(component.pendingAttachments()).toEqual([]);
    });

    it("stages files dropped anywhere over the dialog", async () => {
      const component = await create();
      const event = {
        dataTransfer: transfer([png()]),
        preventDefault: vi.fn(),
      } as unknown as DragEvent;

      component.onDrop(event);

      // Without preventDefault the browser navigates to the dropped file and the composer is gone.
      expect(event.preventDefault).toHaveBeenCalled();
      expect(component.pendingAttachments()).toHaveLength(1);
      expect(component.dragActive()).toBe(false);
    });

    it("uploads staged files to the card the create returned", async () => {
      const component = await create();
      component.setTitle("With a screenshot");
      component.onPaste(pasteOf([png()]));

      await component.submit();

      expect(api.request).toHaveBeenCalledWith("/cards/card-1/attachments", expect.objectContaining({ method: "POST" }));
      const [, init] = api.request.mock.calls[0] as [string, RequestInit];
      expect(((init.body as FormData).get("file") as File).name).toBe("shot.png");
      expect(component.pendingAttachments()).toEqual([]);
    });

    it("reports an upload failure and keeps the file staged", async () => {
      api.request.mockRejectedValue(new Error("quota"));
      const component = await create();
      component.setTitle("With a screenshot");
      component.onPaste(pasteOf([png()]));

      await component.submit();

      expect(component.error()).toContain("shot.png");
      // The card exists; the file does not. Keeping it staged is what makes that recoverable.
      expect(component.pendingAttachments()).toHaveLength(1);
    });
  });

  describe("cross-board hosts", () => {
    const BOARD_GROUPS = [{
      id: "ws-1",
      label: "Delivery",
      options: [
        { id: "board-1", label: "Alpha", icon: "layout-kanban", color: null },
        { id: "board-2", label: "Beta", icon: "layout-kanban", color: null },
      ],
    }];

    it("shows the board chip only where there is a choice", async () => {
      const fixed = await create();
      expect(fixed.showBoardPicker()).toBe(false);

      const choosing = await create({ boardGroups: BOARD_GROUPS });
      expect(choosing.showBoardPicker()).toBe(true);
      expect(choosing.selectedBoard()?.label).toBe("Alpha");
    });

    it("asks the host to retarget rather than writing the board itself", async () => {
      const component = await create({ boardGroups: BOARD_GROUPS });
      const emitted: string[] = [];
      component.boardIdChange.subscribe((id) => emitted.push(id));

      component.selectBoard("board-2");

      expect(emitted).toEqual(["board-2"]);
      // The host owns boardId, so the composer must not have moved on its own.
      expect(component.boardId()).toBe("board-1");
    });

    // Lists, labels and custom fields are workspace-scoped and members are board-scoped, so a move
    // to another workspace has to drop selections the target cannot honour.
    it("clears workspace-scoped selections when the board moves to another workspace", async () => {
      const component = await create({ boardGroups: BOARD_GROUPS, workspaceId: "ws-1" });
      component.toggleLabel("label-1");
      component.toggleAssignee("user-1");
      component.setCheckboxField({ id: "field-1" } as never, true);

      fixture.componentRef.setInput("boardId", "board-2");
      fixture.componentRef.setInput("workspaceId", "ws-2");
      fixture.componentRef.setInput("lists", []);
      fixture.detectChanges();
      await fixture.whenStable();

      expect(component.draft().labelIds).toEqual([]);
      expect(component.draft().assigneeIds).toEqual([]);
      expect(component.draft().customFields).toEqual({});
      expect(component.draft().boardId).toBe("board-2");
    });

    // Same workspace means the lists, labels and fields still exist; only board membership changed.
    it("keeps workspace-scoped selections when the board stays in the same workspace", async () => {
      const component = await create({ boardGroups: BOARD_GROUPS, workspaceId: "ws-1" });
      component.toggleLabel("label-1");
      component.toggleAssignee("user-1");

      fixture.componentRef.setInput("boardId", "board-2");
      fixture.detectChanges();
      await fixture.whenStable();

      expect(component.draft().labelIds).toEqual(["label-1"]);
      expect(component.draft().assigneeIds).toEqual([]);
    });
  });
});
