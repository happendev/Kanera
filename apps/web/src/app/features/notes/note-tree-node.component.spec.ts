import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router } from "@angular/router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteTreeNode } from "./notes.types";
import { NoteTreeNodeComponent } from "./note-tree-node.component";

describe("NoteTreeNodeComponent", () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: Router,
          useValue: {
            createUrlTree: vi.fn(() => ({})),
            serializeUrl: vi.fn(() => "/notes?noteId=note-1"),
          },
        },
        { provide: ActivatedRoute, useValue: {} },
      ],
    }).compileComponents();
  });

  it("keeps note actions behind one contextual menu", async () => {
    const fixture = TestBed.createComponent(NoteTreeNodeComponent);
    fixture.componentRef.setInput("node", createNode());
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;

    const actionTrigger = host.querySelector<HTMLButtonElement>(".nt-actions > .nt-act")!;
    expect(actionTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("[role=menu]")).toBeNull();

    actionTrigger.click();
    await fixture.whenStable();

    const actions = [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
    expect(actions.map((button) => button.textContent?.trim())).toEqual([
      "Add sub-note",
      "Duplicate",
      "Delete",
    ]);
    expect(actionTrigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("runs the selected action and closes the menu", async () => {
    const fixture = TestBed.createComponent(NoteTreeNodeComponent);
    fixture.componentRef.setInput("node", createNode());
    const duplicate = vi.fn();
    fixture.componentInstance.duplicateNode.subscribe(duplicate);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;

    host.querySelector<HTMLButtonElement>(".nt-actions > .nt-act")!.click();
    await fixture.whenStable();
    const actions = [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
    actions.find((button) => button.textContent?.includes("Duplicate"))!.click();
    await fixture.whenStable();

    expect(duplicate).toHaveBeenCalledWith("note-1");
    expect(host.querySelector("[role=menu]")).toBeNull();
  });
});

function createNode(): NoteTreeNode {
  return {
    id: "note-1",
    workspaceId: "workspace-1",
    boardId: "board-1",
    parentNoteId: null,
    scope: "personal",
    ownerId: "user-1",
    lastEditedById: "user-1",
    lastEditedByName: "Owner",
    lastEditedByAvatarUrl: null,
    lastEditedAt: new Date("2026-09-05T00:00:00.000Z"),
    title: "Standup",
    content: "",
    icon: null,
    color: null,
    position: "1000.0000000000",
    editingUserId: null,
    editingExpiresAt: null,
    createdAt: new Date("2026-09-05T00:00:00.000Z"),
    updatedAt: new Date("2026-09-05T00:00:00.000Z"),
    children: [],
  };
}
