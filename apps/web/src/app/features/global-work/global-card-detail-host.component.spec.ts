import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { WorkCard, WorkCatalog } from "@kanera/shared/dto";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { SocketService } from "../../core/realtime/socket.service";
import { BoardSocketBridge } from "../board/board-socket-bridge";
import { BoardState } from "../board/board-state";
import { GlobalCardDetailHostComponent } from "./global-card-detail-host.component";

const card: WorkCard = {
  id: "40000000-0000-4000-8000-000000000001",
  boardId: "30000000-0000-4000-8000-000000000001",
  workspaceId: "20000000-0000-4000-8000-000000000001",
  listId: "50000000-0000-4000-8000-000000000001",
  title: "Ship it",
  position: "1000.0000000000",
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
};

const catalog: WorkCatalog = {
  organisations: [{ id: "10000000-0000-4000-8000-000000000001", name: "Kanera", external: false }],
  workspaces: [{
    id: card.workspaceId,
    organisationId: "10000000-0000-4000-8000-000000000001",
    name: "Delivery",
    icon: null,
    accentColor: null,
    kind: "standard",
    viewerCanAccessWorkspace: true,
  }],
  boards: [{
    id: card.boardId,
    workspaceId: card.workspaceId,
    name: "Roadmap",
    icon: "layout-kanban",
    iconColor: "blue",
    viewerRole: "editor",
    assignedItemsOnly: false,
  }],
  lists: [{
    id: card.listId,
    workspaceId: card.workspaceId,
    name: "Next",
    icon: "list",
    color: null,
    position: "1000.0000000000",
  }],
  labels: [],
  customFields: [],
  people: [{
    userId: "60000000-0000-4000-8000-000000000001",
    organisationId: "10000000-0000-4000-8000-000000000001",
    displayName: "Viewer",
    avatarUrl: null,
    boardIds: [card.boardId],
  }],
};

describe("GlobalCardDetailHostComponent", () => {
  it("mounts from the catalog without waiting for the board request", async () => {
    const hydrate = vi.fn<(payload: {
      board: { id: string };
      cards: Array<{ id: string }>;
      lists: Array<{ id: string }>;
    }) => void>();
    const socket = { on: vi.fn(), off: vi.fn() };
    const get = vi.fn(() => new Promise<never>(() => undefined));

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get } },
        { provide: AuthService, useValue: { user: () => ({ id: "60000000-0000-4000-8000-000000000001" }) } },
        { provide: OfflineCacheService, useValue: { loadBoard: vi.fn() } },
        { provide: SocketService, useValue: { connect: vi.fn(() => socket) } },
      ],
    })
      .overrideComponent(GlobalCardDetailHostComponent, {
        set: {
          template: "",
          providers: [
            { provide: BoardState, useValue: { hydrate } },
            { provide: BoardSocketBridge, useValue: { attach: vi.fn(() => vi.fn()) } },
          ],
        },
      })
      .compileComponents();

    const fixture = TestBed.createComponent(GlobalCardDetailHostComponent);
    fixture.componentRef.setInput("card", card);
    fixture.componentRef.setInput("catalog", catalog);
    fixture.detectChanges();

    expect(get).toHaveBeenCalledWith(`/boards/${card.boardId}?includeCards=false`);
    const provisional = hydrate.mock.calls[0]?.[0];
    expect(provisional?.board.id).toBe(card.boardId);
    expect(provisional?.cards.map((candidate) => candidate.id)).toEqual([card.id]);
    expect(provisional?.lists.map((candidate) => candidate.id)).toEqual([card.listId]);
    expect(fixture.componentInstance.ready()).toBe(true);

    fixture.destroy();
  });
});
