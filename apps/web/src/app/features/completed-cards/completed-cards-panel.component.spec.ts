import { ChangeDetectionStrategy, Component, input, output, provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { CompletedCardsResponse } from "@kanera/shared/dto";
import type { WireCardSummary } from "@kanera/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import type { AppSocket } from "../../core/realtime/socket.service";
import { SocketService } from "../../core/realtime/socket.service";
import { CardComponent } from "../board/card.component";
import { CompletedCardsPanelComponent } from "./completed-cards-panel.component";

const toFile = vi.fn();

vi.mock("write-excel-file/browser", () => ({
  default: vi.fn(() => ({ toFile })),
}));

class SocketStub {
  private readonly handlers = new Map<string, (...args: never[]) => void>();
  readonly on = vi.fn((event: string, handler: (...args: never[]) => void) => { this.handlers.set(event, handler); return this; });
  readonly off = vi.fn((event: string) => { this.handlers.delete(event); return this; });
  trigger(event: string) { this.handlers.get(event)?.(); }
  asSocket(): AppSocket {
    return this as unknown as AppSocket;
  }
}

class IntersectionObserverStub {
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
}

@Component({ selector: "k-card", standalone: true, changeDetection: ChangeDetectionStrategy.OnPush, template: "" })
class CardStubComponent {
  readonly card = input.required<unknown>();
  readonly customFields = input<unknown>();
  readonly customFieldValuesByField = input<unknown>();
  readonly labels = input<unknown>();
  readonly assignees = input<unknown>();
  readonly coverUrl = input<unknown>();
  readonly attachmentCount = input<unknown>();
  readonly commentCount = input<unknown>();
  readonly showActions = input<unknown>();
  readonly allowDuplicate = input<unknown>();
  readonly allowCopyToBoard = input<unknown>();
  readonly boardSummary = input<unknown>();
  readonly hideCompletedAccent = input<unknown>();
  readonly openCard = output<void>();
}

function summary(overrides: Partial<WireCardSummary> = {}): WireCardSummary {
  return {
    id: overrides.id ?? "card-1",
    listId: overrides.listId ?? "list-1",
    boardId: overrides.boardId ?? "board-1",
    title: overrides.title ?? "Completed card",
    position: overrides.position ?? "1000.0000000000",
    dueDateLocalDate: overrides.dueDateLocalDate ?? null,
    dueDateSlot: overrides.dueDateSlot ?? null,
    dueDateTimezone: overrides.dueDateTimezone ?? null,
    completedAt: overrides.completedAt ?? new Date("2026-05-20T12:00:00.000Z"),
    archivedAt: overrides.archivedAt ?? null,
    coverAttachmentId: overrides.coverAttachmentId ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-05-19T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-05-20T12:00:00.000Z"),
    hasDescription: false,
    commentCount: 0,
    attachmentCount: 0,
    checklistDoneCount: 0,
    checklistTotalCount: 0,
    coverUrl: null,
    coverImageWidth: null,
    coverImageHeight: null,
    coverImageColor: null,
    labelIds: [],
    assigneeIds: [],
    customFieldValues: [],
    ...overrides,
  };
}

type ApiGetMock = ReturnType<typeof vi.fn<(path: string) => Promise<CompletedCardsResponse>>>;

function configure(get: ApiGetMock) {
  const socket = new SocketStub();
  TestBed.overrideComponent(CompletedCardsPanelComponent, {
    remove: { imports: [CardComponent] },
    add: { imports: [CardStubComponent] },
  }).configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiClient, useValue: { get } },
      { provide: SocketService, useValue: { connect: () => socket.asSocket() } },
    ],
  });
}

function setup(scope: "board" | "assigned", get: ApiGetMock) {
  configure(get);
  const fixture = TestBed.createComponent(CompletedCardsPanelComponent);
  fixture.componentRef.setInput("scope", scope);
  fixture.componentRef.setInput("boardId", "board-1");
  fixture.componentRef.setInput("boardName", "Roadmap");
  fixture.componentRef.setInput("workspaceId", "workspace-1");
  fixture.componentRef.setInput("userId", "user-1");
  fixture.componentRef.setInput("lists", [{ id: "list-1", name: "Done" }]);
  fixture.componentRef.setInput("boards", [{ id: "board-1", name: "Roadmap", icon: null, iconColor: null }]);
  fixture.componentRef.setInput("customFields", []);
  fixture.componentRef.setInput("cardLabels", []);
  fixture.componentRef.setInput("members", []);
  fixture.detectChanges();
  return fixture;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("CompletedCardsPanelComponent", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:completed-export") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    toFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it("renders the export menu in board and assigned-work scope", async () => {
    const get = vi.fn<(path: string) => Promise<CompletedCardsResponse>>().mockResolvedValue({ cards: [], nextCursor: null });

    let fixture = setup("board", get);
    await flush();
    let host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>(".completed-export-btn")?.click();
    fixture.detectChanges();
    expect(host.textContent).toContain("JSON");
    expect(host.textContent).toContain("Excel");
    expect([...host.querySelectorAll<HTMLElement>(".completed-export-item span")].map((item) => item.textContent?.trim())).toEqual(["Excel", "JSON"]);

    TestBed.resetTestingModule();
    fixture = setup("assigned", get);
    await flush();
    host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>(".completed-export-btn")?.click();
    fixture.detectChanges();
    expect(host.textContent).toContain("JSON");
    expect(host.textContent).toContain("Excel");
  });

  it("reloads its completed-card cache after an access-scope reconnect", async () => {
    const get = vi.fn<(path: string) => Promise<CompletedCardsResponse>>()
      .mockResolvedValueOnce({ cards: [], nextCursor: null })
      .mockResolvedValueOnce({ cards: [summary({ id: "newly-visible" })], nextCursor: null });
    const fixture = setup("board", get);
    await flush();
    const socket = TestBed.inject(SocketService).connect() as unknown as SocketStub;
    socket.trigger("connect");
    await flush();

    expect(get).toHaveBeenCalledTimes(2);
    expect(fixture.componentInstance.cards().map((card) => card.id)).toEqual(["newly-visible"]);
  });

  it("hides and blocks export when the viewer is an observer", async () => {
    const get = vi.fn<(path: string) => Promise<CompletedCardsResponse>>().mockResolvedValue({ cards: [], nextCursor: null });
    const fixture = setup("board", get);
    fixture.componentRef.setInput("canExport", false);
    fixture.detectChanges();
    await flush();
    get.mockClear();

    expect((fixture.nativeElement as HTMLElement).querySelector(".completed-export-btn")).toBeNull();
    await fixture.componentInstance.exportJson();
    await fixture.componentInstance.exportExcel();
    expect(get).not.toHaveBeenCalled();
    expect(toFile).not.toHaveBeenCalled();
  });

  it("JSON export fetches every cursor page with the current filters", async () => {
    const get = vi.fn((path: string): Promise<CompletedCardsResponse> => {
      const url = new URL(path, "https://kanera.test");
      if (url.searchParams.get("limit") === "30") return Promise.resolve({ cards: [], nextCursor: null });
      if (!url.searchParams.get("cursor")) return Promise.resolve({ cards: [summary({ id: "card-1" })], nextCursor: "next-1" });
      return Promise.resolve({ cards: [summary({ id: "card-2" })], nextCursor: null });
    });
    const fixture = setup("board", get);
    const component = fixture.componentInstance;
    component.searchQuery.set("launch");
    component.from.set("2026-05-01");
    component.to.set("2026-05-31");
    component.listId.set("list-1");
    await flush();
    get.mockClear();

    await component.exportJson();

    expect(get).toHaveBeenCalledTimes(2);
    const urls = get.mock.calls.map(([path]) => new URL(path, "https://kanera.test"));
    expect(urls[0]?.pathname).toBe("/boards/board-1/completed");
    expect(urls[0]?.searchParams.get("limit")).toBe("100");
    expect(urls[0]?.searchParams.get("q")).toBe("launch");
    expect(urls[0]?.searchParams.get("listId")).toBe("list-1");
    expect(urls[0]?.searchParams.get("from")).toBe(new Date("2026-05-01T00:00:00.000").toISOString());
    expect(urls[0]?.searchParams.get("to")).toBe(new Date("2026-05-31T23:59:59.999").toISOString());
    expect(urls[1]?.searchParams.get("cursor")).toBe("next-1");
  });

  it("Excel export fetches every cursor page with assigned-work board filters", async () => {
    const get = vi.fn((path: string): Promise<CompletedCardsResponse> => {
      const url = new URL(path, "https://kanera.test");
      if (url.searchParams.get("limit") === "30") return Promise.resolve({ cards: [], nextCursor: null });
      if (!url.searchParams.get("cursor")) return Promise.resolve({ cards: [summary({ id: "card-1" })], nextCursor: "next-1" });
      return Promise.resolve({ cards: [summary({ id: "card-2" })], nextCursor: null });
    });
    const fixture = setup("assigned", get);
    const component = fixture.componentInstance;
    component.searchQuery.set("mine");
    component.from.set("2026-05-10");
    component.to.set("2026-05-20");
    component.listId.set("list-1");
    component.boardFilterId.set("board-1");
    await flush();
    get.mockClear();

    await component.exportExcel();

    expect(get).toHaveBeenCalledTimes(2);
    const urls = get.mock.calls.map(([path]) => new URL(path, "https://kanera.test"));
    expect(urls[0]?.pathname).toBe("/workspaces/workspace-1/assignees/user-1/completed");
    expect(urls[0]?.searchParams.get("limit")).toBe("100");
    expect(urls[0]?.searchParams.get("q")).toBe("mine");
    expect(urls[0]?.searchParams.get("listId")).toBe("list-1");
    expect(urls[0]?.searchParams.get("boardId")).toBe("board-1");
    expect(urls[0]?.searchParams.get("from")).toBe(new Date("2026-05-10T00:00:00.000").toISOString());
    expect(urls[0]?.searchParams.get("to")).toBe(new Date("2026-05-20T23:59:59.999").toISOString());
    expect(urls[1]?.searchParams.get("cursor")).toBe("next-1");
    expect(toFile).toHaveBeenCalledWith(expect.stringMatching(/^completed-assigned-work-/));
  });

  it("shows an inline export error without closing the drawer", async () => {
    const get = vi.fn((path: string): Promise<CompletedCardsResponse> => {
      const url = new URL(path, "https://kanera.test");
      if (url.searchParams.get("limit") === "30") return Promise.resolve({ cards: [], nextCursor: null });
      return Promise.reject(new Error("nope"));
    });
    const fixture = setup("board", get);
    await flush();

    await fixture.componentInstance.exportJson();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(".completed-panel")).not.toBeNull();
    expect(host.textContent).toContain("Completed cards could not be exported.");
  });

  it("suppresses expired signed cover URLs before passing completed cards to k-card", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-06-26T12:00:00.000Z"));
    const expiredCover = "https://board.kanera.app/api/media/client-1/cards/card-1/cover.png?t=token&e=1782474900000";
    const get = vi.fn<(path: string) => Promise<CompletedCardsResponse>>()
      .mockResolvedValue({ cards: [summary({ coverUrl: expiredCover })], nextCursor: null });
    const fixture = setup("board", get);
    await flush();

    expect(fixture.componentInstance.coverUrlForCard(fixture.componentInstance.cards()[0]!)).toBeNull();
  });

  it("shows group titles and counts and collapses date groups independently", async () => {
    const get = vi.fn<(path: string) => Promise<CompletedCardsResponse>>().mockResolvedValue({
      cards: [
        summary({ id: "may-20-a" }),
        summary({ id: "may-20-b", completedAt: new Date("2026-05-20T10:00:00.000Z") }),
        summary({ id: "may-19", completedAt: new Date("2026-05-19T10:00:00.000Z") }),
      ],
      nextCursor: null,
    });
    const fixture = setup("board", get);
    await flush();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const groups = [...host.querySelectorAll<HTMLElement>(".completed-group")];
    const headers = [...host.querySelectorAll<HTMLElement>(".completed-group-header")];
    expect(headers.map((header) => header.querySelector(".completed-group-identity span")?.textContent)).toEqual(
      fixture.componentInstance.cardGroups().map((group) => group.label),
    );
    expect(headers.map((header) => header.querySelector(".completed-group-count")?.textContent)).toEqual(["2", "1"]);
    expect(groups[0]!.querySelectorAll("k-card")).toHaveLength(2);
    expect(groups[1]!.querySelectorAll("k-card")).toHaveLength(1);

    const firstToggle = groups[0]!.querySelector<HTMLButtonElement>(".completed-group-toggle")!;
    firstToggle.click();
    fixture.detectChanges();

    expect(firstToggle.getAttribute("aria-expanded")).toBe("false");
    expect(groups[0]!.classList.contains("is-collapsed")).toBe(true);
    expect(groups[0]!.querySelectorAll("k-card")).toHaveLength(0);
    expect(groups[1]!.querySelectorAll("k-card")).toHaveLength(1);
  });
});
