import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import type { List, Workspace } from "@kanera/shared/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { NotificationsService } from "../../core/notifications/notifications.service";
import type { HomeBoardWithStats, HomeResponse } from "../../core/offline/offline-cache.service";
import { ShareTargetPage } from "./share-target.page";

const workspace = (id = "workspace-1", role = "member", name = "Marketing"): Workspace & { role: string } => ({
  id,
  clientId: "client-1",
  name,
  kind: "standard",
  icon: null,
  accentColor: null,
  completedCardsActiveDays: 35,
  boardLinkingEnabled: true,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  archivedAt: null,
  role,
});

const board = (id = "board-1", workspaceId = "workspace-1", viewerRole: "editor" | "observer" = "editor"): HomeBoardWithStats => ({
  id,
  workspaceId,
  groupId: null,
  standaloneGroupId: null,
  name: id === "board-1" ? "Campaigns" : "Shared launch",
  icon: null,
  iconColor: null,
  backgroundGradient: null,
  position: "1000.0000000000",
  viewerRole,
  myCards: 0,
  myOverdue: 0,
});

const list = (id = "list-1", workspaceId = "workspace-1"): List => ({
  id,
  workspaceId,
  name: id === "list-1" ? "Inbox" : "Later",
  icon: null,
  color: null,
  position: "1000.0000000000",
  archivedAt: null,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
});

const defaultHome = (): HomeResponse => ({
  groups: [{ workspace: workspace(), boardGroups: [], boards: [board()], members: [] }],
  guestGroups: [],
  dueSoon: [],
  overdueChecklistItems: 0,
});

describe("ShareTargetPage", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  async function render(options: {
    home?: HomeResponse;
    inputs?: Partial<{ title: string; text: string; url: string; shareKey: string }>;
    lists?: Record<string, List[]>;
  } = {}) {
    const home = options.home ?? defaultHome();
    const lists = options.lists ?? { "board-1": [list()] };
    const get = vi.fn((path: string) => {
      if (path === "/home/boards") return Promise.resolve(home);
      const boardId = /^\/boards\/([^/]+)\/lists$/.exec(path)?.[1];
      if (boardId && lists[boardId]) return Promise.resolve(lists[boardId]);
      return Promise.reject(new Error(`unexpected get ${path}`));
    });
    const createCard = vi.fn((_path: string, _body: unknown) => Promise.resolve({ id: "card-1", boardId: "board-1" }));
    const watchCreatedCardLocally = vi.fn();
    const navigate = vi.fn(() => Promise.resolve(true));

    await TestBed.configureTestingModule({
      imports: [ShareTargetPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get, createCard } },
        { provide: NotificationsService, useValue: { watchCreatedCardLocally } },
        { provide: Router, useValue: { navigate } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(ShareTargetPage);
    const inputs = options.inputs ?? {
      title: "Shared headline",
      text: "Read this brief",
      url: "https://example.com/brief",
    };
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(fixture.componentInstance.canSave()).toBe(true));
    fixture.detectChanges();

    return { component: fixture.componentInstance, fixture, get, createCard, watchCreatedCardLocally, navigate };
  }

  it("creates a card from shared title, text, and url", async () => {
    const { component, get, createCard, watchCreatedCardLocally, navigate } = await render();

    expect(component.cardTitle()).toBe("Shared headline");
    expect(component.description()).toBe("Read this brief\n\nhttps://example.com/brief");
    expect(component.selectedBoardId()).toBe("board-1");
    expect(component.selectedListId()).toBe("list-1");
    expect(get).toHaveBeenCalledWith("/boards/board-1/lists");

    await component.save();

    expect(createCard).toHaveBeenCalledTimes(1);
    const [createPath, rawCreateBody] = createCard.mock.calls[0]!;
    const createBody = rawCreateBody as { title: string; description: string; clientToken: string };
    expect(createPath).toBe("/boards/board-1/lists/list-1/cards");
    expect(createBody).toMatchObject({
      title: "Shared headline",
      description: "Read this brief\n\nhttps://example.com/brief",
    });
    expect(createBody.clientToken).toMatch(/^[0-9a-f-]{36}$/i);
    expect(watchCreatedCardLocally).toHaveBeenCalledWith("card-1");
    expect(navigate).toHaveBeenCalledWith(["/b", "board-1"], {
      queryParams: { cardId: "card-1" },
      replaceUrl: true,
    });
  });

  it("offers guest editor boards and excludes observer-only boards", async () => {
    const ownWorkspace = workspace();
    const guestWorkspace = workspace("workspace-2", "editor", "Partner launch");
    const home = {
      ...defaultHome(),
      groups: [{ workspace: ownWorkspace, boardGroups: [], boards: [board("board-1", ownWorkspace.id, "observer")], members: [] }],
      guestGroups: [{
        workspace: guestWorkspace,
        clientName: "Partner Co",
        boardGroups: [],
        boards: [board("board-2", guestWorkspace.id, "editor")],
      }],
    };

    const { component, fixture, get } = await render({
      home,
      lists: { "board-2": [list("list-2", guestWorkspace.id)] },
    });

    expect(component.groups()).toHaveLength(1);
    expect(component.groups()[0]?.label).toBe("Partner launch · Partner Co");
    expect(component.selectedBoardId()).toBe("board-2");
    expect(component.selectedListId()).toBe("list-2");
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain("Campaigns");
    expect(get).toHaveBeenCalledWith("/boards/board-2/lists");
  });

  it("consumes and deletes the service worker's one-time shared payload", async () => {
    const shareKey = "c168b13a-37a8-4f40-89f7-29aa6fbb4e24";
    const match = vi.fn((_url: string) => Promise.resolve(new Response(JSON.stringify({
      title: "Cached article",
      text: "Saved without putting this text in the URL",
      url: "https://example.com/cached",
    }))));
    const deletePayload = vi.fn((_url: string) => Promise.resolve(true));
    vi.stubGlobal("caches", { open: vi.fn(() => Promise.resolve({ match, delete: deletePayload })) });

    const { component } = await render({ inputs: { shareKey } });

    const payloadUrl = match.mock.calls[0]?.[0] ?? "";
    expect(new URL(payloadUrl).pathname).toBe(`/share-target-payload/${shareKey}`);
    expect(deletePayload).toHaveBeenCalledWith(payloadUrl);
    expect(component.cardTitle()).toBe("Cached article");
    expect(component.description()).toBe("Saved without putting this text in the URL\n\nhttps://example.com/cached");
  });

  it("restores the last successful destination when it is still editable", async () => {
    localStorage.setItem(STORAGE_KEYS.SHARE_TARGET_DESTINATION, JSON.stringify({ boardId: "board-2", listId: "list-2" }));
    const home = defaultHome();
    home.groups[0]!.boards.push(board("board-2"));

    const { component } = await render({
      home,
      lists: { "board-1": [list()], "board-2": [list("list-2")] },
    });

    expect(component.selectedBoardId()).toBe("board-2");
    expect(component.selectedListId()).toBe("list-2");
  });

  it("turns a copied URL into a useful card through the manual paste fallback", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn(() => Promise.resolve("https://www.example.com/article")) },
    });
    const { component } = await render({ inputs: {} });

    await component.pasteFromClipboard();

    expect(component.cardTitle()).toBe("example.com");
    expect(component.description()).toBe("https://www.example.com/article");
    expect(component.hasIncomingContent()).toBe(true);
    expect(component.captureNotice()).toBe("Clipboard content added.");
  });
});
