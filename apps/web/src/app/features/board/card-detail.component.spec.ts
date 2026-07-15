import { provideZonelessChangeDetection, signal } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import type { CardAttachmentRow } from "@kanera/shared/dto";
import type { ActivityFeedEvent, CardFeedItem, WireBoardMemberUser, WireCard, WireCardChecklist, WireCardChecklistItem, WireCardDetail, WireChecklistTemplate, WireComment } from "@kanera/shared/events";
import type { CardCustomFieldValue, CustomField } from "@kanera/shared/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../../core/api/api.client";
import type { AuthUser } from "../../core/auth/auth.service";
import { AuthService } from "../../core/auth/auth.service";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { UnsavedWorkService } from "../../core/browser/unsaved-work.service";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { PresenceService } from "../../core/realtime/presence.service";
import type { AppSocket } from "../../core/realtime/socket.service";
import { SocketService } from "../../core/realtime/socket.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { ConfirmService } from "../../shared/confirm.service";
import { BoardState } from "./board-state";
import { CardActivityComponent } from "./card-activity.component";
import { CardDetailComponent, checklistDragScrollStep } from "./card-detail.component";

describe("card detail checklist drag scrolling", () => {
  it("scrolls toward either panel edge and stays still in the middle", () => {
    expect(checklistDragScrollStep(105, 100, 700)).toBeLessThan(0);
    expect(checklistDragScrollStep(400, 100, 700)).toBe(0);
    expect(checklistDragScrollStep(695, 100, 700)).toBeGreaterThan(0);
  });

  it("caps scrolling when the pointer moves outside the panel body", () => {
    expect(checklistDragScrollStep(0, 100, 700)).toBe(-20);
    expect(checklistDragScrollStep(800, 100, 700)).toBe(20);
  });
});
import { DescriptionEditorComponent } from "./description-editor.component";
import { ImageLightboxService } from "./image-lightbox.service";

class SocketStub {
  connected = true;
  readonly emit = vi.fn(() => this);

  readonly on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = this.handlers.get(event) ?? new Set<(...args: unknown[]) => void>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return this;
  });

  readonly off = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    this.handlers.get(event)?.delete(handler);
    return this;
  });

  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  trigger(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  asSocket(): AppSocket {
    return this as unknown as AppSocket;
  }
}

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: IntersectionObserverCallback) {
    IntersectionObserverStub.instances.push(this);
  }

  trigger(isIntersecting = true) {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }

  trigger(width: number) {
    this.callback([
      {
        target: document.createElement("div"),
        contentRect: { width } as DOMRectReadOnly,
        contentBoxSize: [{ inlineSize: width }] as ResizeObserverSize[],
        borderBoxSize: [{ inlineSize: width }] as ResizeObserverSize[],
        devicePixelContentBoxSize: [{ inlineSize: width }] as ResizeObserverSize[],
      } as unknown as ResizeObserverEntry,
    ], this as unknown as ResizeObserver);
  }
}

function createCard(overrides: Partial<WireCard> = {}): WireCard {
  return {
    id: "card-1",
    listId: "list-1",
    boardId: "board-1",
    title: "Ship realtime tests",
    description: null,
    position: "1000.0000000000",
    dueDateLocalDate: null,
    dueDateSlot: null,
    dueDateTimezone: null,
    completedAt: null,
    archivedAt: null,
    createdById: "user-1",
    coverAttachmentId: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function createComment(overrides: Partial<WireComment> = {}): WireComment {
  return {
    id: "comment-1",
    cardId: "card-1",
    authorId: "user-2",
    authorKind: "user",
    apiKeyId: null,
    apiKeyName: null,
    authorName: "Ada Lovelace",
    authorAvatarUrl: null,
    body: "Looks good to me.",
    editedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    reactions: [],
    ...overrides,
  };
}

function createActivity(overrides: Partial<ActivityFeedEvent> = {}): ActivityFeedEvent {
  return {
    id: "activity-1",
    boardId: "board-1",
    workspaceId: "workspace-1",
    actorId: "user-2",
    actorKind: "user",
    apiKeyId: null,
    apiKeyName: null,
    supportSessionId: null,
    supportActorEmail: null,
    actorName: "Ada Lovelace",
    actorAvatarUrl: null,
    entityType: "card",
    entityId: "card-1",
    action: "updated",
    payload: { description: "Updated" },
    feedVisible: true,
    coalesceKey: "card:description",
    coalescedCount: 1,
    coalescedUntil: new Date("2026-05-21T00:02:00.000Z"),
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function createCardDetail(overrides: Partial<WireCardDetail> = {}): WireCardDetail {
  return {
    card: createCard(),
    customFieldValues: [],
    labelIds: [],
    assigneeIds: [],
    attachments: [],
    checklists: [],
    appliedChecklistTemplateIds: [],
    linkedNotes: [],
    ...overrides,
  };
}

function createAttachment(overrides: Partial<CardAttachmentRow> = {}): CardAttachmentRow {
  return {
    id: "attachment-1",
    cardId: "card-1",
    fileName: "spec.png",
    mimeType: "image/png",
    byteSize: 1024,
    url: "https://example.com/spec.png",
    thumbnailUrl: "https://example.com/spec-thumb.png",
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    uploadedById: "user-1",
    uploadedByName: "Owner",
    uploadedByAvatarUrl: null,
    source: "attachment",
    commentId: null,
    ...overrides,
  };
}

function createCustomField(overrides: Partial<CustomField> = {}): CustomField {
  return {
    id: "field-1",
    workspaceId: "workspace-1",
    name: "Priority",
    type: "text",
    icon: "forms",
    allowMultiple: false,
    position: "1000.0000000000",
    showOnCard: true,
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function createCustomFieldValue(overrides: Partial<CardCustomFieldValue> = {}): CardCustomFieldValue {
  return {
    cardId: "card-1",
    fieldId: "field-1",
    valueText: null,
    valueNumber: null,
    valueCheckbox: null,
    valueDate: null,
    valueUrl: null,
    valueOptionIds: null,
    valueUserIds: null,
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function createChecklistFixture(overrides: Partial<WireCardChecklist> = {}): WireCardChecklist {
  return {
    id: "checklist-1",
    cardId: "card-1",
    parentItemId: null,
    title: "Launch prep",
    position: "1000.0000000000",
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    items: [],
    ...overrides,
  };
}

function createChecklistItemFixture(overrides: Partial<WireCardChecklistItem> = {}): WireCardChecklistItem {
  return {
    id: "item-1",
    checklistId: "checklist-1",
    text: "Confirm launch copy",
    description: null,
    position: "1000.0000000000",
    assigneeId: null,
    dueDateLocalDate: null,
    dueDateSlot: null,
    dueDateTimezone: null,
    completedAt: null,
    completedById: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function createChecklistTemplateFixture(overrides: Partial<WireChecklistTemplate> = {}): WireChecklistTemplate {
  return {
    id: "template-1",
    workspaceId: "workspace-1",
    title: "QA checklist",
    position: "1000.0000000000",
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    items: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Let the /cards/:id/detail fetch settle so the gated detail body renders, mirroring production where
// that body only appears after the async load. Flushing microtasks (rather than vi.waitFor) keeps this
// usable under fake timers, since the fetch resolves on the microtask queue, not a timer.
async function settleDetail(fixture: ComponentFixture<CardDetailComponent>) {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  fixture.detectChanges();
}

function clipboardFileItem(file: File): DataTransferItem {
  return {
    kind: "file",
    type: file.type,
    getAsFile: () => file,
  } as DataTransferItem;
}

function pasteEvent(data: { items: DataTransferItem[]; files: File[] }): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: data.items,
      files: data.files,
      getData: vi.fn(() => ""),
    },
  });
  return event;
}

function dragEvent(type: "dragover" | "drop", data: { files: File[]; target?: Element }): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: ["Files"],
      items: data.files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
      files: data.files,
      dropEffect: "none",
    },
  });
  if (data.target) {
    Object.defineProperty(event, "target", { value: data.target });
  }
  return event;
}

describe("CardDetailComponent realtime regressions", () => {
  let api: {
    get: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    upload: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let offlineCache: { loadCardDetail: ReturnType<typeof vi.fn>; saveBoard: ReturnType<typeof vi.fn>; saveCardDetail: ReturnType<typeof vi.fn> };
  let imageLightbox: { open: ReturnType<typeof vi.fn> };
  let notifications: { isWatchingCard: ReturnType<typeof vi.fn>; isWatchingBoard: ReturnType<typeof vi.fn>; toggleCardWatch: ReturnType<typeof vi.fn>; beginViewingCard: ReturnType<typeof vi.fn> };
  let socket: SocketStub;
  let socketService: { connect: ReturnType<typeof vi.fn>; displayedOnline: ReturnType<typeof signal<boolean>>; joinWorkspace: ReturnType<typeof vi.fn> };
  let viewerRole: ReturnType<typeof signal<"owner" | "admin" | "editor" | "observer" | null>>;
  let canEditLive: ReturnType<typeof signal<boolean>>;
  let isOrgAdmin: ReturnType<typeof signal<boolean>>;
  let isPlanLimited: ReturnType<typeof signal<boolean>>;
  let authUser: ReturnType<typeof signal<AuthUser | null>>;
  let notificationStateVersion: ReturnType<typeof signal<number>>;
  // Stateful stand-in for BoardState's detail store, kept in lockstep with production: on first open
  // BoardState has no detail (null), the component fetches /cards/:id/detail, and setCardDetail stores
  // the result — which is when the gated detail body (custom fields, checklists, linked items,
  // attachments) becomes visible. Tests that assert on that body therefore drive the same async load
  // via settleDetail(); a card whose detail is already cached is modelled by mockReturnValue.
  let boardStateDetail: ReturnType<typeof signal<WireCardDetail | null>>;
  let workspaceKind: ReturnType<typeof signal<"standard" | "board" | null>>;
  // Mirrors BoardState.cardDetailRealtimeRevision: bumped when a realtime detail mutation is recorded,
  // so tests can simulate a socket update landing mid-/detail-fetch and assert the stale response is
  // not mirrored back over it.
  let cardDetailRevision: number;
  let boardChecklistTemplates: ReturnType<typeof signal<WireChecklistTemplate[]>>;

  beforeEach(async () => {
    boardStateDetail = signal<WireCardDetail | null>(null);
    workspaceKind = signal<"standard" | "board" | null>("standard");
    boardChecklistTemplates = signal<WireChecklistTemplate[]>([]);
    cardDetailRevision = 0;
    IntersectionObserverStub.instances = [];
    ResizeObserverStub.instances = [];
    vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    api = {
      get: vi.fn((path: string) =>
        path.endsWith("/detail")
          ? Promise.resolve({ card: createCard(), customFieldValues: [], labelIds: [], assigneeIds: [], attachments: [], checklists: [], appliedChecklistTemplateIds: [], linkedNotes: [] })
          : path === "/workspaces/workspace-1"
            ? Promise.resolve({ checklistTemplates: [] })
            : Promise.resolve({ items: [], nextCursor: null }),
      ),
      request: vi.fn(() => Promise.resolve(createAttachment())),
      upload: vi.fn(() => Promise.resolve(createAttachment())),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    offlineCache = {
      loadCardDetail: vi.fn(() => Promise.resolve(null)),
      saveBoard: vi.fn(() => Promise.resolve()),
      saveCardDetail: vi.fn(() => Promise.resolve()),
    };
    socket = new SocketStub();
    socketService = { connect: vi.fn(() => socket.asSocket()), displayedOnline: signal(true), joinWorkspace: vi.fn(() => vi.fn()) };
    imageLightbox = { open: vi.fn() };
    notificationStateVersion = signal(0);
    notifications = {
      isWatchingCard: vi.fn(() => false),
      isWatchingBoard: vi.fn(() => false),
      toggleCardWatch: vi.fn(() => Promise.resolve()),
      // Model the real service's synchronous signal reads before returning cleanup.
      beginViewingCard: vi.fn(() => {
        notificationStateVersion();
        return vi.fn();
      }),
    };
    viewerRole = signal<"owner" | "admin" | "editor" | "observer" | null>("editor");
    canEditLive = signal(true);
    isOrgAdmin = signal(false);
    isPlanLimited = signal(false);

    authUser = signal<AuthUser | null>({
      id: "user-1",
      clientId: "client-1",
      email: "owner@example.com",
      displayName: "Owner",
      avatarUrl: null,
      orgName: "Kanera",
      logoUrl: null,
      deploymentMode: "self_hosted",
      hasWorkspace: true,
      role: "owner",
      timezone: "UTC",
      storageUsage: {
        usedBytes: 0,
        quotaBytes: null,
        remainingBytes: null,
        limited: false,
        maxFileBytes: 250 * 1024 * 1024,
      },
    });

    await TestBed.configureTestingModule({
      imports: [CardDetailComponent, CardActivityComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        {
          provide: AuthService,
          useValue: {
            user: authUser.asReadonly(),
            isOrgAdmin,
            isPlanLimited,
            getAccessToken: vi.fn(),
            refresh: vi.fn(),
          },
        },
        { provide: SocketService, useValue: socketService },
        {
          provide: PresenceService,
          useValue: {
            watchWorkspace: vi.fn(() => vi.fn()),
            isOnline: vi.fn((_workspaceId: string | null | undefined, userId: string | null | undefined) => userId === "user-2"),
            lastOnlineAt: vi.fn(() => null),
          },
        },
        { provide: OfflineCacheService, useValue: offlineCache },
        { provide: ImageLightboxService, useValue: imageLightbox },
        { provide: NotificationsService, useValue: notifications },
        { provide: WorkspaceService, useValue: { workspaceIdForBoard: () => "workspace-1", boardSummaryFor: () => null } },
        {
          provide: BoardState,
          useValue: {
            detailForCard: vi.fn((_cardId: string) => boardStateDetail()),
            setCardDetail: vi.fn((detail: WireCardDetail) => boardStateDetail.set(detail)),
            cardDetailRealtimeRevision: vi.fn(() => cardDetailRevision),
            noteCardDetailRealtimeMutation: vi.fn(() => { cardDetailRevision += 1; }),
            setCardAssignees: vi.fn(),
            updateCard: vi.fn(),
            canEdit: () => canEditLive(),
            canEditRole: () => viewerRole() !== null && viewerRole() !== "observer",
            viewerRole,
            workspaceKind,
            board: () => ({ id: "board-1", workspaceId: "workspace-1" }),
            lists: () => [{ id: "list-1", name: "To do", icon: null, color: null }],
            visibleLists: () => [{ id: "list-1", name: "To do", icon: null, color: null }],
            checklistTemplates: boardChecklistTemplates,
            updateChecklistItem: vi.fn(),
          },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEYS.COLLAPSED_CHECKLISTS);
    localStorage.removeItem(STORAGE_KEYS.EDITOR_DRAFTS);
    vi.useRealTimers();
    document.querySelectorAll(".cdk-overlay-container").forEach((el) => el.remove());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps copy but hides move-to-board in standalone card actions", async () => {
    workspaceKind.set("board");
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    await settleDetail(fixture);
    fixture.componentInstance.actionsMenuOpen.set(true);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";

    expect(text).toContain("Copy to board");
    expect(text).not.toContain("Move to board");
  });

  it("uses restored board detail when opening a card offline", async () => {
    const restoredDetail = {
      card: createCard({ description: "Cached board detail" }),
      customFieldValues: [],
      labelIds: [],
      assigneeIds: [],
      attachments: [],
      checklists: [],
      appliedChecklistTemplateIds: [], linkedNotes: [],
    };
    const boardState = TestBed.inject(BoardState) as unknown as { detailForCard: ReturnType<typeof vi.fn> };
    boardState.detailForCard.mockReturnValue(restoredDetail);
    socketService.displayedOnline.set(false);

    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard({ description: null }));
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => {
      expect(fixture.componentInstance.draftDescription()).toBe("Cached board detail");
    });
    expect(offlineCache.loadCardDetail).not.toHaveBeenCalled();
  });

  it("registers the active card view without retriggering on notification state changes", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard({ id: "card-opened" }));
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => {
      expect(notifications.beginViewingCard).toHaveBeenCalledWith("card-opened", "board-1");
    });

    notificationStateVersion.update((version) => version + 1);
    fixture.detectChanges();

    expect(notifications.beginViewingCard).toHaveBeenCalledTimes(1);
  });

  it("cleans up the active card view on destroy", async () => {
    const cleanup = vi.fn();
    notifications.beginViewingCard.mockReturnValue(cleanup);
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard({ id: "card-opened" }));
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => expect(notifications.beginViewingCard).toHaveBeenCalled());
    fixture.destroy();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("moves the active card view when the open card changes", async () => {
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();
    notifications.beginViewingCard
      .mockReturnValueOnce(firstCleanup)
      .mockReturnValueOnce(secondCleanup);
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard({ id: "card-opened" }));
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => expect(notifications.beginViewingCard).toHaveBeenCalledWith("card-opened", "board-1"));

    fixture.componentRef.setInput("card", createCard({ id: "card-next" }));
    fixture.detectChanges();

    await vi.waitFor(() => expect(notifications.beginViewingCard).toHaveBeenCalledWith("card-next", "board-1"));
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(secondCleanup).not.toHaveBeenCalled();
  });

  it("restores checklist collapse state for the opened card after checklist detail loads", async () => {
    localStorage.setItem(STORAGE_KEYS.COLLAPSED_CHECKLISTS, JSON.stringify({
      "card-1": ["checklist-1"],
      "card-2": ["checklist-2"],
    }));

    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", []);
    fixture.detectChanges();

    expect(fixture.componentInstance.isChecklistCollapsed("checklist-1")).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.COLLAPSED_CHECKLISTS) ?? "{}")).toEqual({
      "card-1": ["checklist-1"],
      "card-2": ["checklist-2"],
    });

    fixture.componentRef.setInput("checklists", [createChecklistFixture()]);
    fixture.detectChanges();

    expect(fixture.componentInstance.isChecklistCollapsed("checklist-1")).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.COLLAPSED_CHECKLISTS) ?? "{}")).toEqual({
      "card-1": ["checklist-1"],
      "card-2": ["checklist-2"],
    });
  });

  it("focuses the dialog container instead of the complete button when opened", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await Promise.resolve();

    const host = fixture.nativeElement as HTMLElement;
    const panel = host.querySelector(".panel") as HTMLElement | null;
    const completionButton = host.querySelector(".completion-btn") as HTMLButtonElement | null;

    expect(panel).not.toBeNull();
    expect(completionButton).not.toBeNull();
    expect(document.activeElement).toBe(panel);
    expect(document.activeElement).not.toBe(completionButton);
  });

  it("uploads pasted screenshots as card attachments without opening description edit mode", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard({ description: "Existing description" }));
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    const file = new File(["image"], "screenshot.png", { type: "image/png" });
    const event = pasteEvent({ items: [clipboardFileItem(file)], files: [] });
    const panel = fixture.nativeElement.querySelector(".panel") as HTMLElement;

    panel.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    expect(api.upload).toHaveBeenCalledWith(
      "/cards/card-1/attachments",
      expect.any(FormData),
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    expect(fixture.componentInstance.editingDescription()).toBe(false);
  });

  it("uploads files dropped onto the card detail panel outside an editor", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard({ description: "Existing description" }));
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector(".panel") as HTMLElement;
    const file = new File(["image"], "dropped.png", { type: "image/png" });
    const over = dragEvent("dragover", { files: [file], target: panel });

    document.dispatchEvent(over);
    fixture.detectChanges();

    expect(over.defaultPrevented).toBe(true);
    expect(fixture.componentInstance.attachmentDragActive()).toBe(true);

    const drop = dragEvent("drop", { files: [file], target: panel });
    document.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    expect(api.upload).toHaveBeenCalledWith(
      "/cards/card-1/attachments",
      expect.any(FormData),
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
  });

  it("does not intercept drops inside the description editor", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard({ description: "Existing description" }));
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    fixture.componentInstance.startEditDescription();
    fixture.detectChanges();

    const editor = fixture.nativeElement.querySelector("k-description-editor") as HTMLElement;
    const file = new File(["image"], "inline.png", { type: "image/png" });
    const drop = dragEvent("drop", { files: [file], target: editor });

    document.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(false);
    expect(api.upload).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
  });

  it("clears the panel drop overlay when dragging onto the description editor", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard({ description: "Existing description" }));
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector(".panel") as HTMLElement;
    const file = new File(["image"], "inline.png", { type: "image/png" });

    document.dispatchEvent(dragEvent("dragover", { files: [file], target: panel }));
    expect(fixture.componentInstance.attachmentDragActive()).toBe(true);

    fixture.componentInstance.startEditDescription();
    fixture.detectChanges();

    const editor = fixture.nativeElement.querySelector("k-description-editor") as HTMLElement;
    editor.dispatchEvent(dragEvent("dragover", { files: [file] }));

    expect(fixture.componentInstance.attachmentDragActive()).toBe(false);
  });

  it("defers oversized card attachments to the server's per-file limit (host-pays)", async () => {
    // Per-file size is no longer pre-blocked client-side: the limit belongs to the board OWNER's org
    // (a free guest may upload large files to a paid host board), so the client sends the file and the
    // server's FILE_TOO_LARGE response — carrying the owner's maxFileBytes — drives the error.
    api.upload.mockRejectedValueOnce(
      new ApiError(400, { code: "FILE_TOO_LARGE", maxFileBytes: 250 * 1024 * 1024 }),
    );
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    const file = new File(["x"], "large.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", { value: 250 * 1024 * 1024 + 1 });
    await fixture.componentInstance.onAttachmentSelected({
      target: { files: [file], value: "C:\\fakepath\\large.mp4" },
    } as unknown as Event);

    expect(api.upload).toHaveBeenCalled();
    // The failed upload becomes a retryable queue item carrying the server-driven size message.
    await vi.waitFor(() => expect(fixture.componentInstance.uploads.items()[0]?.error).toBe("File is too large (max 250 MB)"));
  });

  it("tells free-plan admins to upgrade when a card attachment is too large", async () => {
    isOrgAdmin.set(true);
    isPlanLimited.set(true);
    api.upload.mockRejectedValueOnce(
      new ApiError(400, { code: "FILE_TOO_LARGE", maxFileBytes: 5 * 1024 * 1024 }),
    );
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await fixture.componentInstance.onAttachmentSelected({
      target: { files: [new File(["x"], "large.mp4", { type: "video/mp4" })], value: "C:\\fakepath\\large.mp4" },
    } as unknown as Event);

    await vi.waitFor(() => expect(fixture.componentInstance.uploads.items()[0]?.error).toBe("File is too large (max 5 MB). Upgrade your plan for higher file limits."));
  });

  it("downloads attachments with the stored file name", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    const blob = new Blob(["doc"], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, blob: () => Promise.resolve(blob) })));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:download");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    let anchor: HTMLAnchorElement | null = null;
    const originalCreateElement = document.createElement.bind(document);
    const createElement = vi.spyOn(document, "createElement").mockImplementation((tagName: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement(tagName, options);
      if (tagName.toLowerCase() === "a") anchor = element as HTMLAnchorElement;
      return element;
    });

    await fixture.componentInstance.downloadAttachment(
      "https://api.test/api/media/client-1/cards/card-1/01901234-5678-7abc-8def-0123456789ab.docx?t=token&e=9999999999999",
      "Project brief.docx",
    );

    expect(fetch).toHaveBeenCalledWith("https://api.test/api/media/client-1/cards/card-1/01901234-5678-7abc-8def-0123456789ab.docx?t=token&e=9999999999999");
    const downloadAnchor = anchor as HTMLAnchorElement | null;
    expect(downloadAnchor?.href).toBe("blob:download");
    expect(downloadAnchor?.download).toBe("Project brief.docx");
    expect(click).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:download");
    createElement.mockRestore();
  });

  it("shows a friendly message when attachment upload returns 413", async () => {
    api.upload.mockRejectedValueOnce(new ApiError(413, { message: "request entity too large" }));
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await fixture.componentInstance.onAttachmentSelected({
      target: { files: [new File(["x"], "large.mp4", { type: "video/mp4" })], value: "C:\\fakepath\\large.mp4" },
    } as unknown as Event);

    await vi.waitFor(() => expect(fixture.componentInstance.uploads.items()[0]?.error).toBe("File is too large (max 250 MB)"));
  });

  it("shows a role-aware message when attachment upload is blocked by org storage quota", async () => {
    // Member view (isOrgAdmin stubbed false): directed to ask an admin rather than to upgrade.
    api.upload.mockRejectedValueOnce(new ApiError(403, { code: "STORAGE_QUOTA_EXCEEDED" }));
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await fixture.componentInstance.onAttachmentSelected({
      target: { files: [new File(["x"], "quota.txt", { type: "text/plain" })], value: "C:\\fakepath\\quota.txt" },
    } as unknown as Event);

    await vi.waitFor(() => expect(fixture.componentInstance.uploads.items()[0]?.error).toBe("Your organisation's storage is full. Ask an organisation admin to upgrade for more storage."));
  });

  it("allows normal text paste inside editable fields in card detail", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    fixture.componentInstance.editTitle();
    fixture.detectChanges();

    const file = new File(["image"], "screenshot.png", { type: "image/png" });
    const event = pasteEvent({ items: [clipboardFileItem(file)], files: [] });
    const input = fixture.nativeElement.querySelector(".title-input") as HTMLInputElement;

    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(api.request).not.toHaveBeenCalled();
  });

  it("renders authorName from realtime comment events", async () => {
    const fixture = TestBed.createComponent(CardActivityComponent);

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => {
      expect(api.get).toHaveBeenCalledWith("/cards/card-1/feed?limit=50");
      expect(socketService.connect).toHaveBeenCalledTimes(1);
    });

    socket.trigger("card:feedItem:created", {
      boardId: "board-1",
      cardId: "card-1",
      item: { type: "comment", data: createComment() },
    });
    fixture.detectChanges();

    await vi.waitFor(() => {
      const author = fixture.nativeElement.querySelector(".comment-author") as HTMLElement | null;
      const avatar = fixture.nativeElement.querySelector(".comment-avatar") as HTMLElement | null;

      expect(author?.textContent).toContain("Ada Lovelace");
      expect(avatar?.textContent?.trim()).toBe("A");
      const [item] = fixture.componentInstance.feedItems();
      expect(item?.type).toBe("comment");
      if (item?.type !== "comment") throw new Error("Expected comment feed item");
      expect(item.data.authorName).toBe("Ada Lovelace");
    });
  });

  it("does not merge a stale loadMore page into the feed after the card switches", async () => {
    const loadMore = deferred<{ items: CardFeedItem[]; nextCursor: string | null }>();
    api.get.mockImplementation((path: string) => {
      if (path === "/cards/card-1/feed?limit=50") {
        return Promise.resolve({ items: [{ type: "activity", data: createActivity({ id: "activity-card-1" }) }], nextCursor: "cursor-1" });
      }
      if (path === "/cards/card-1/feed?limit=50&cursor=cursor-1") return loadMore.promise;
      if (path === "/cards/card-2/feed?limit=50") {
        return Promise.resolve({ items: [{ type: "activity", data: createActivity({ id: "activity-card-2" }) }], nextCursor: null });
      }
      if (path.endsWith("/detail")) return Promise.resolve(createCardDetail());
      return Promise.resolve({ items: [], nextCursor: null });
    });

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => expect(fixture.componentInstance.feedItems().map((item) => item.data.id)).toEqual(["activity-card-1"]));

    // Kick off a next-page load for card-1, then switch to card-2 before it resolves.
    const pending = fixture.componentInstance.loadMoreFeed();
    fixture.componentRef.setInput("cardId", "card-2");
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.feedItems().map((item) => item.data.id)).toEqual(["activity-card-2"]));

    // The stale page resolves after the switch — it must not append to card-2's feed.
    loadMore.resolve({ items: [{ type: "comment", data: createComment({ id: "comment-card-1-old" }) }], nextCursor: null });
    await pending;

    expect(fixture.componentInstance.feedItems().map((item) => item.data.id)).toEqual(["activity-card-2"]);
  });

  it("union-merges the feed page with a realtime item that arrives mid-request", async () => {
    const feed = deferred<{ items: CardFeedItem[]; nextCursor: string | null }>();
    api.get.mockImplementation((path: string) => {
      if (path === "/cards/card-1/feed?limit=50") return feed.promise;
      if (path.endsWith("/detail")) return Promise.resolve(createCardDetail());
      return Promise.resolve({ items: [], nextCursor: null });
    });

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => expect(socketService.connect).toHaveBeenCalled());

    // A realtime comment lands while the initial feed request is still in flight.
    socket.trigger("card:feedItem:created", {
      boardId: "board-1",
      cardId: "card-1",
      item: { type: "comment", data: createComment({ id: "comment-live" }) },
    });

    // The server page (which predates the live comment) resolves and must not clobber it.
    feed.resolve({ items: [{ type: "activity", data: createActivity({ id: "activity-server" }) }], nextCursor: null });
    await vi.waitFor(() => expect(fixture.componentInstance.feedItems().length).toBe(2));

    const ids = fixture.componentInstance.feedItems().map((item) => item.data.id);
    expect(ids).toContain("comment-live");
    expect(ids).toContain("activity-server");
  });

  it("applies a realtime reaction that arrives before its comment loads", async () => {
    const feed = deferred<{ items: CardFeedItem[]; nextCursor: string | null }>();
    api.get.mockImplementation((path: string) => {
      if (path === "/cards/card-1/feed?limit=50") return feed.promise;
      if (path.endsWith("/detail")) return Promise.resolve(createCardDetail());
      return Promise.resolve({ items: [], nextCursor: null });
    });

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    await vi.waitFor(() => expect(socketService.connect).toHaveBeenCalled());

    const user = { id: "user-3", displayName: "Grace Hopper", avatarUrl: null };
    socket.trigger("comment:reaction:added", {
      boardId: "board-1",
      cardId: "card-1",
      commentId: "comment-1",
      type: "thumbs_up",
      user,
    });

    // The request began before the reaction and returns the old comment snapshot.
    feed.resolve({ items: [{ type: "comment", data: createComment({ id: "comment-1", reactions: [] }) }], nextCursor: null });
    await vi.waitFor(() => expect(fixture.componentInstance.feedItems().length).toBe(1));

    const [item] = fixture.componentInstance.feedItems();
    if (item?.type !== "comment") throw new Error("Expected comment feed item");
    expect(item.data.reactions).toEqual([{
      type: "thumbs_up",
      count: 1,
      userIds: ["user-3"],
      users: [user],
    }]);
  });

  it("applies a realtime reaction removal that arrives before its comment loads", async () => {
    const feed = deferred<{ items: CardFeedItem[]; nextCursor: string | null }>();
    api.get.mockImplementation((path: string) => {
      if (path === "/cards/card-1/feed?limit=50") return feed.promise;
      if (path.endsWith("/detail")) return Promise.resolve(createCardDetail());
      return Promise.resolve({ items: [], nextCursor: null });
    });

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    await vi.waitFor(() => expect(socketService.connect).toHaveBeenCalled());

    socket.trigger("comment:reaction:removed", {
      boardId: "board-1",
      cardId: "card-1",
      commentId: "comment-1",
      type: "thumbs_up",
      userId: "user-3",
    });
    feed.resolve({
      items: [{
        type: "comment",
        data: createComment({
          id: "comment-1",
          reactions: [{
            type: "thumbs_up",
            count: 1,
            userIds: ["user-3"],
            users: [{ id: "user-3", displayName: "Grace Hopper", avatarUrl: null }],
          }],
        }),
      }],
      nextCursor: null,
    });
    await vi.waitFor(() => expect(fixture.componentInstance.feedItems().length).toBe(1));

    const [item] = fixture.componentInstance.feedItems();
    if (item?.type !== "comment") throw new Error("Expected comment feed item");
    expect(item.data.reactions).toEqual([]);
  });

  it("does not let a stale feed page overwrite a realtime comment edit", async () => {
    const feed = deferred<{ items: CardFeedItem[]; nextCursor: string | null }>();
    api.get.mockImplementation((path: string) => {
      if (path === "/cards/card-1/feed?limit=50") return feed.promise;
      if (path.endsWith("/detail")) return Promise.resolve(createCardDetail());
      return Promise.resolve({ items: [], nextCursor: null });
    });

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => expect(socketService.connect).toHaveBeenCalled());

    // A realtime edit updates the comment body while the initial page request is in flight.
    socket.trigger("card:feedItem:updated", {
      boardId: "board-1",
      cardId: "card-1",
      item: { type: "comment", data: createComment({ id: "comment-1", body: "Edited live" }) },
    });

    // The page carries the pre-edit body; the current (realtime) value must win on the collision.
    feed.resolve({ items: [{ type: "comment", data: createComment({ id: "comment-1", body: "Stale body" }) }], nextCursor: null });
    await vi.waitFor(() => expect(fixture.componentInstance.feedItems().length).toBe(1));

    const [item] = fixture.componentInstance.feedItems();
    if (item?.type !== "comment") throw new Error("Expected comment feed item");
    expect(item.data.body).toBe("Edited live");
  });

  it("does not let a stale feed page resurrect a realtime-deleted item", async () => {
    const feed = deferred<{ items: CardFeedItem[]; nextCursor: string | null }>();
    api.get.mockImplementation((path: string) => {
      if (path === "/cards/card-1/feed?limit=50") return feed.promise;
      if (path.endsWith("/detail")) return Promise.resolve(createCardDetail());
      return Promise.resolve({ items: [], nextCursor: null });
    });

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => expect(socketService.connect).toHaveBeenCalled());

    // A realtime delete removes a comment mid-request. The page still contains it.
    socket.trigger("card:feedItem:deleted", {
      boardId: "board-1",
      cardId: "card-1",
      type: "comment",
      itemId: "comment-gone",
    });

    feed.resolve({
      items: [
        { type: "comment", data: createComment({ id: "comment-gone" }) },
        { type: "activity", data: createActivity({ id: "activity-server" }) },
      ],
      nextCursor: null,
    });
    await vi.waitFor(() => expect(fixture.componentInstance.feedItems().map((i) => i.data.id)).toEqual(["activity-server"]));
    expect(fixture.componentInstance.feedItems().some((i) => i.data.id === "comment-gone")).toBe(false);
  });

  it("does not clear the new card's pagination loader when a stale page from the previous card resolves", async () => {
    const loadMoreA = deferred<{ items: CardFeedItem[]; nextCursor: string | null }>();
    const loadMoreB = deferred<{ items: CardFeedItem[]; nextCursor: string | null }>();
    api.get.mockImplementation((path: string) => {
      if (path === "/cards/card-1/feed?limit=50") return Promise.resolve({ items: [{ type: "activity", data: createActivity({ id: "a1" }) }], nextCursor: "cursor-a" });
      if (path === "/cards/card-1/feed?limit=50&cursor=cursor-a") return loadMoreA.promise;
      if (path === "/cards/card-2/feed?limit=50") return Promise.resolve({ items: [{ type: "activity", data: createActivity({ id: "b1" }) }], nextCursor: "cursor-b" });
      if (path === "/cards/card-2/feed?limit=50&cursor=cursor-b") return loadMoreB.promise;
      if (path.endsWith("/detail")) return Promise.resolve(createCardDetail());
      return Promise.resolve({ items: [], nextCursor: null });
    });

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.feedHasMore()).toBe(true));

    // Start paginating card-1, switch to card-2, then start paginating card-2.
    const pendingA = fixture.componentInstance.loadMoreFeed();
    fixture.componentRef.setInput("cardId", "card-2");
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.feedHasMore()).toBe(true));
    const pendingB = fixture.componentInstance.loadMoreFeed();
    expect(fixture.componentInstance.feedLoadingMore()).toBe(true);

    // card-1's stale page resolves last; it must not release card-2's still-active loader.
    loadMoreA.resolve({ items: [{ type: "comment", data: createComment({ id: "a-old" }) }], nextCursor: null });
    await pendingA;
    expect(fixture.componentInstance.feedLoadingMore()).toBe(true);

    loadMoreB.resolve({ items: [{ type: "comment", data: createComment({ id: "b-old" }) }], nextCursor: null });
    await pendingB;
    expect(fixture.componentInstance.feedLoadingMore()).toBe(false);
  });

  it("shows the empty activity state, not an error, when an empty feed is recovered from cache", async () => {
    const onlineFeed: CardFeedItem[] = [{ type: "activity", data: createActivity({ id: "activity-online" }) }];
    api.get.mockImplementation((path: string) => {
      if (path === "/cards/card-1/feed?limit=50") return Promise.resolve({ items: onlineFeed, nextCursor: null });
      return Promise.resolve({ items: [], nextCursor: null });
    });

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.feedItems().length).toBe(1));

    // Switch to a card whose cache proves it has no activity (recovered, but zero rows).
    offlineCache.loadCardDetail.mockResolvedValue({
      cardId: "card-2",
      cachedAt: new Date("2026-05-21T00:00:00.000Z").toISOString(),
      detail: createCardDetail(),
      feed: [],
    });
    socketService.displayedOnline.set(false);
    fixture.componentRef.setInput("cardId", "card-2");
    fixture.detectChanges();

    await vi.waitFor(() => expect(offlineCache.loadCardDetail).toHaveBeenCalledWith("card-2"));
    await vi.waitFor(() => expect(fixture.componentInstance.feedLoading()).toBe(false));
    expect(fixture.componentInstance.feedItems()).toEqual([]);
    // Recovered-but-empty is a legitimate empty state, not a load failure.
    expect(fixture.componentInstance.feedError()).toBe(false);
  });

  it("keeps the visible feed when the authenticated user snapshot refreshes", async () => {
    const onlineFeed: CardFeedItem[] = [{ type: "activity", data: createActivity({ id: "activity-online" }) }];
    api.get.mockImplementation((path: string) => {
      if (path === "/cards/card-1/feed?limit=50") return Promise.resolve({ items: onlineFeed, nextCursor: null });
      return Promise.resolve({ items: [], nextCursor: null });
    });

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => expect(fixture.componentInstance.feedItems().map((item) => item.data.id)).toEqual(["activity-online"]));
    const feedRequestCount = api.get.mock.calls.filter(([path]) => path === "/cards/card-1/feed?limit=50").length;

    authUser.update((user) => user ? { ...user, timezone: "Europe/London" } : user);
    fixture.detectChanges();

    expect(fixture.componentInstance.feedItems().map((item) => item.data.id)).toEqual(["activity-online"]);
    expect(api.get.mock.calls.filter(([path]) => path === "/cards/card-1/feed?limit=50")).toHaveLength(feedRequestCount);
    expect(fixture.nativeElement.querySelector(".no-activity")).toBeNull();
  });

  it("does not show comment author presence for historical authors no longer in members", async () => {
    const fixture = TestBed.createComponent(CardActivityComponent);

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => expect(socketService.connect).toHaveBeenCalledTimes(1));
    socket.trigger("card:feedItem:created", {
      boardId: "board-1",
      cardId: "card-1",
      item: { type: "comment", data: createComment({ authorId: "user-2" }) },
    });
    fixture.detectChanges();

    await vi.waitFor(() => expect(fixture.nativeElement.querySelector(".comment-avatar k-avatar")).toBeTruthy());
    expect(fixture.nativeElement.querySelector(".comment-avatar .presence-dot")).toBeNull();

    fixture.componentRef.setInput("members", [{ userId: "user-2", displayName: "Ada Lovelace", avatarUrl: null, role: "editor", source: "workspace" }]);
    fixture.detectChanges();

    await vi.waitFor(() => expect(fixture.nativeElement.querySelector(".comment-avatar .presence-dot")).toBeTruthy());
  });

  it("persists a newly submitted comment into the offline feed snapshot", async () => {
    const detail = createCardDetail();
    const state = TestBed.inject(BoardState) as unknown as { detailForCard: ReturnType<typeof vi.fn> };
    state.detailForCard.mockReturnValue(detail);
    api.post.mockResolvedValueOnce(createComment({ id: "comment-created", body: "Saved before disconnect" }));

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith("/cards/card-1/feed?limit=50"));
    offlineCache.saveCardDetail.mockClear();

    await fixture.componentInstance.submitComment({ markdown: "Saved before disconnect", attachmentIds: [] });

    expect(fixture.componentInstance.feedItems().map((item) => item.data.id)).toEqual(["comment-created"]);
    expect(offlineCache.saveCardDetail).toHaveBeenCalledWith(
      "card-1",
      detail,
      [{ type: "comment", data: expect.objectContaining({ id: "comment-created", body: "Saved before disconnect" }) }],
    );
  });

  it("saves a new comment as a local draft when send is pressed offline", async () => {
    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    fixture.componentInstance.startAddComment();
    socketService.displayedOnline.set(false);
    await fixture.componentInstance.submitComment({ markdown: "Offline comment", attachmentIds: [] });

    const store = JSON.parse(localStorage.getItem(STORAGE_KEYS.EDITOR_DRAFTS) ?? "{}") as Record<string, { markdown?: string; baseMarkdown?: string }>;
    expect(api.post).not.toHaveBeenCalled();
    expect(fixture.componentInstance.addingComment()).toBe(false);
    expect(fixture.componentInstance.recoveredNewCommentDraft()).toBe(true);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("Offline comment");
    expect(root.querySelector("k-draft-banner")).not.toBeNull();
    expect(root.textContent).toContain("Saved as draft. Reconnect to publish.");
    expect(store["comment-new:user-1:card-1"]).toEqual(expect.objectContaining({
      markdown: "Offline comment",
      baseMarkdown: "",
    }));

    socketService.displayedOnline.set(true);
    fixture.detectChanges();
    root.querySelector<HTMLElement>(".comment-body.draft-preview")?.click();
    expect(fixture.componentInstance.newCommentInitialValue()).toBe("Offline comment");
    expect(fixture.componentInstance.addingComment()).toBe(true);
  });

  it("preserves and closes an open new comment composer when the card goes offline", async () => {
    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    fixture.componentInstance.startAddComment();
    fixture.componentInstance.onNewCommentDraftChange("Offline comment");
    socketService.displayedOnline.set(false);
    fixture.detectChanges();

    await vi.waitFor(() => expect(fixture.componentInstance.addingComment()).toBe(false));

    const store = JSON.parse(localStorage.getItem(STORAGE_KEYS.EDITOR_DRAFTS) ?? "{}") as Record<string, { markdown?: string; baseMarkdown?: string }>;
    expect(fixture.componentInstance.recoveredNewCommentDraft()).toBe(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("Offline comment");
    expect(store["comment-new:user-1:card-1"]).toEqual(expect.objectContaining({
      markdown: "Offline comment",
      baseMarkdown: "",
    }));
  });

  it("shows the new comment draft banner when an open composer goes offline", async () => {
    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    fixture.componentInstance.startAddComment();
    fixture.detectChanges();
    const editor = fixture.debugElement.query((de) => de.componentInstance instanceof DescriptionEditorComponent)
      .componentInstance as DescriptionEditorComponent;
    editor.setMarkdown("Offline comment");

    socketService.displayedOnline.set(false);
    fixture.detectChanges();

    await vi.waitFor(() => expect(fixture.componentInstance.addingComment()).toBe(false));
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.recoveredNewCommentDraft()).toBe(true);
    expect(root.querySelector("k-draft-banner")).not.toBeNull();
    expect(root.textContent).toContain("Saved as draft. Reconnect to publish.");
    expect(root.textContent).toContain("Offline comment");
  });

  it("saves an edited comment as a local draft when save is pressed offline", async () => {
    const comment = createComment({ id: "comment-1", body: "Saved comment" });

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith("/cards/card-1/feed?limit=50"));
    fixture.componentInstance.feedItems.set([{ type: "comment", data: comment }]);

    fixture.componentInstance.startEditComment(comment);
    socketService.displayedOnline.set(false);
    await fixture.componentInstance.saveEditComment(comment.id, { markdown: "Offline edit", attachmentIds: [] });

    const store = JSON.parse(localStorage.getItem(STORAGE_KEYS.EDITOR_DRAFTS) ?? "{}") as Record<string, { markdown?: string; baseMarkdown?: string }>;
    expect(api.patch).not.toHaveBeenCalled();
    expect(fixture.componentInstance.editingCommentId()).toBeNull();
    expect(fixture.componentInstance.recoveredEditCommentDraft()).toBe(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("Offline edit");
    expect(store["comment-edit:user-1:comment-1"]).toEqual(expect.objectContaining({
      markdown: "Offline edit",
      baseMarkdown: "Saved comment",
    }));

    socketService.displayedOnline.set(true);
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(".comment-body.draft-preview")?.click();
    expect(fixture.componentInstance.editCommentBody()).toBe("Offline edit");
    expect(fixture.componentInstance.editingCommentId()).toBe(comment.id);
  });

  it("preserves and closes an open comment editor when the card goes offline", async () => {
    const comment = createComment({ id: "comment-1", body: "Saved comment" });

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith("/cards/card-1/feed?limit=50"));
    fixture.componentInstance.feedItems.set([{ type: "comment", data: comment }]);

    fixture.componentInstance.startEditComment(comment);
    fixture.componentInstance.onEditCommentDraftChange(comment, "Offline edit");
    socketService.displayedOnline.set(false);
    fixture.detectChanges();

    await vi.waitFor(() => expect(fixture.componentInstance.editingCommentId()).toBeNull());

    const store = JSON.parse(localStorage.getItem(STORAGE_KEYS.EDITOR_DRAFTS) ?? "{}") as Record<string, { markdown?: string; baseMarkdown?: string }>;
    expect(fixture.componentInstance.recoveredEditCommentDraft()).toBe(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("Offline edit");
    expect(store["comment-edit:user-1:comment-1"]).toEqual(expect.objectContaining({
      markdown: "Offline edit",
      baseMarkdown: "Saved comment",
    }));
  });

  it("keeps the visible feed when going offline with an empty cached feed", async () => {
    const onlineFeed: CardFeedItem[] = [{ type: "activity", data: createActivity({ id: "activity-online" }) }];
    api.get.mockImplementation((path: string) => {
      if (path === "/cards/card-1/feed?limit=50") return Promise.resolve({ items: onlineFeed, nextCursor: null });
      return Promise.resolve({ items: [], nextCursor: null });
    });

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => expect(fixture.componentInstance.feedItems().map((item) => item.data.id)).toEqual(["activity-online"]));

    offlineCache.loadCardDetail.mockResolvedValue({
      cardId: "card-1",
      cachedAt: new Date("2026-05-21T00:00:00.000Z").toISOString(),
      detail: createCardDetail(),
      feed: [],
    });
    socketService.displayedOnline.set(false);
    fixture.detectChanges();

    await vi.waitFor(() => expect(offlineCache.loadCardDetail).toHaveBeenCalledWith("card-1"));
    expect(fixture.componentInstance.feedItems().map((item) => item.data.id)).toEqual(["activity-online"]);
    expect(fixture.nativeElement.querySelector(".activity-item")).not.toBeNull();
    expect(fixture.nativeElement.querySelector(".no-activity")).toBeNull();
  });

  it("renders cached activity when opened offline", async () => {
    const cachedFeed: CardFeedItem[] = [{ type: "comment", data: createComment({ id: "comment-cached" }) }];
    socketService.displayedOnline.set(false);
    offlineCache.loadCardDetail.mockResolvedValue({
      cardId: "card-1",
      cachedAt: new Date("2026-05-21T00:00:00.000Z").toISOString(),
      detail: createCardDetail(),
      feed: cachedFeed,
    });

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", false);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => expect(fixture.componentInstance.feedItems().map((item) => item.data.id)).toEqual(["comment-cached"]));
    fixture.detectChanges();

    expect(api.get).not.toHaveBeenCalledWith("/cards/card-1/feed?limit=50");
    expect(fixture.componentInstance.feedHasMore()).toBe(false);
    expect(fixture.nativeElement.querySelector(".comment-author")?.textContent).toContain("Ada Lovelace");
  });

  it("restores a recovered new-comment draft", async () => {
    const key = "comment-new:user-1:card-1";
    localStorage.setItem(STORAGE_KEYS.EDITOR_DRAFTS, JSON.stringify({
      [key]: {
        key,
        userId: "user-1",
        kind: "comment-new",
        entityId: "card-1",
        cardId: "card-1",
        markdown: "Recovered comment",
        baseMarkdown: "",
        updatedAt: new Date().toISOString(),
      },
    }));

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    expect(fixture.componentInstance.addingComment()).toBe(true);
    expect(fixture.componentInstance.newCommentInitialValue()).toBe("Recovered comment");
    expect(fixture.nativeElement.textContent).toContain("Unsaved draft.");
  });

  it("restores a recovered edit-comment draft from the loaded feed", async () => {
    const key = "comment-edit:user-1:comment-1";
    localStorage.setItem(STORAGE_KEYS.EDITOR_DRAFTS, JSON.stringify({
      [key]: {
        key,
        userId: "user-1",
        kind: "comment-edit",
        entityId: "comment-1",
        cardId: "card-1",
        commentId: "comment-1",
        markdown: "Recovered edit",
        baseMarkdown: "Looks good to me.",
        updatedAt: new Date().toISOString(),
      },
    }));

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    fixture.componentInstance.feedItems.set([{ type: "comment", data: createComment() }]);
    fixture.detectChanges();

    await vi.waitFor(() => expect(fixture.componentInstance.editingCommentId()).toBe("comment-1"));
    expect(fixture.componentInstance.editCommentBody()).toBe("Recovered edit");
    expect(fixture.nativeElement.textContent).toContain("Unsaved draft.");
  });

  it("renders overdue activity wording without the system actor", () => {
    const fixture = TestBed.createComponent(CardActivityComponent);
    const activity = createActivity({
      actorId: null,
      actorKind: "system",
      actorName: "Kanera",
      action: "overdue",
      payload: {
        dueDateLocalDate: "2026-05-20",
        dueDateSlot: "anyTime",
        dueDateTimezone: "Europe/Dublin",
      },
    });

    expect(fixture.componentInstance.activityActorText(activity)).toBeNull();
    expect(fixture.componentInstance.isSystemActivity(activity)).toBe(true);
    expect(fixture.componentInstance.activityText(activity)).toBe('This card is marked as <span class="activity-value activity-value-overdue">overdue</span>');

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    fixture.componentInstance.feedItems.set([{ type: "activity", data: activity }]);
    fixture.detectChanges();

    const item = fixture.nativeElement.querySelector(".activity-item") as HTMLElement | null;
    expect(item?.classList.contains("is-system")).toBe(true);
    expect(fixture.nativeElement.querySelector(".activity-avatar")).toBeNull();
    expect(fixture.nativeElement.querySelector(".activity-text")?.textContent?.trim()).toBe("This card is marked as overdue");
  });

  it("renders copied-card activity as a copy rather than a new card creation", () => {
    const fixture = TestBed.createComponent(CardActivityComponent);
    const activity = createActivity({
      action: "created",
      payload: {
        title: "New copy",
        listId: "list-1",
        duplicatedFromId: "source-card-1",
        duplicatedFromBoardId: "source-board-1",
        duplicatedFromBoardName: "Planning board",
      },
    });

    expect(fixture.componentInstance.activityText(activity)).toBe(
      ' copied this card from <span class="activity-value">Planning board</span>',
    );

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    fixture.componentInstance.feedItems.set([{ type: "activity", data: activity }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector(".activity-text")?.textContent?.trim()).toBe("Ada Lovelace copied this card from Planning board");
  });

  it("renders imported-card activity as an import rather than a new card creation", () => {
    const fixture = TestBed.createComponent(CardActivityComponent);
    const activity = createActivity({
      action: "created",
      payload: {
        title: "Imported card",
        listId: "list-1",
        importedFrom: "trello",
      },
    });

    expect(fixture.componentInstance.activityText(activity)).toBe(" imported this card");

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    fixture.componentInstance.feedItems.set([{ type: "activity", data: activity }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector(".activity-text")?.textContent?.trim()).toBe("Ada Lovelace imported this card");
  });

  it("renders copied historical authors through Kanera when the user is not on the target board", () => {
    const fixture = TestBed.createComponent(CardActivityComponent);
    const comment = createComment({
      id: "comment-copied",
      authorId: "user-1",
      authorKind: "system",
      apiKeyName: "Grace Hopper",
      authorName: "Kanera",
      body: "Original context.",
    });
    const activity = createActivity({
      id: "activity-copied",
      actorId: null,
      actorKind: "system",
      actorName: "Kanera",
      action: "updated",
      payload: { description: "Updated", copiedActorName: "Grace Hopper" },
    });

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    fixture.componentInstance.feedItems.set([
      { type: "activity", data: activity },
      { type: "comment", data: comment },
    ]);
    fixture.detectChanges();

    const commentEl = fixture.nativeElement.querySelector(".comment") as HTMLElement;
    expect(commentEl.classList.contains("is-system")).toBe(true);
    expect(commentEl.querySelector("k-avatar")).toBeNull();
    expect(commentEl.querySelector(".comment-meta")?.textContent?.replace(/\s+/g, " ").trim()).toContain("Kanera (Grace Hopper)");
    expect(Array.from(commentEl.querySelectorAll("button")).map((button) => button.textContent?.trim())).toContain("Reply");
    expect(Array.from(commentEl.querySelectorAll("button")).map((button) => button.textContent?.trim())).not.toContain("Edit");
    expect(Array.from(commentEl.querySelectorAll("button")).map((button) => button.textContent?.trim())).not.toContain("Delete");
    expect(fixture.componentInstance.canReactRole(comment)).toBe(true);
    expect(fixture.nativeElement.querySelector(".activity-text")?.textContent?.trim()).toBe("Kanera (Grace Hopper) updated the description");
  });

  it("renders the label names changed by Kanera activity", () => {
    const fixture = TestBed.createComponent(CardActivityComponent);
    const activity = createActivity({
      actorId: null,
      actorKind: "system",
      actorName: "Kanera",
      action: "labels:set",
      payload: {
        labelIds: ["label-1", "label-2"],
        addedLabelNames: ["Bug", "Urgent"],
        removedLabelNames: [],
      },
    });

    expect(fixture.componentInstance.activityText(activity)).toContain("added labels");
    expect(fixture.componentInstance.activityText(activity)).toContain("Bug");
    expect(fixture.componentInstance.activityText(activity)).toContain("Urgent");

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    fixture.componentInstance.feedItems.set([{ type: "activity", data: activity }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector(".activity-text")?.textContent?.trim()).toBe("Kanera added labels Bug and Urgent");
  });

  it("renders checkbox custom field activity values as Yes and No", () => {
    const fixture = TestBed.createComponent(CardActivityComponent);
    const activity = createActivity({
      action: "customFieldValue:set",
      payload: {
        fieldName: "Approved",
        fromValue: "false",
        toValue: "true",
      },
    });

    expect(fixture.componentInstance.activityText(activity)).toBe(
      ' changed <span class="activity-value">Approved</span>: <span class="activity-value">No</span> <i class="activity-arrow ti ti-arrow-narrow-right"></i> <span class="activity-value">Yes</span>',
    );

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    fixture.componentInstance.feedItems.set([{ type: "activity", data: activity }]);
    fixture.detectChanges();

    const visibleText = fixture.nativeElement.querySelector(".activity-text")?.textContent?.replace(/\s+/g, " ").trim();
    expect(visibleText).toBe("Ada Lovelace changed Approved: No Yes");
  });

  it("opens a modal description diff for audited description activity", () => {
    const fixture = TestBed.createComponent(CardActivityComponent);
    const activity = createActivity({
      payload: {
        description: "Hello brave world",
        fromValue: "Hello world",
        toValue: "Hello brave world",
      },
    });

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    fixture.componentInstance.feedItems.set([{ type: "activity", data: activity }]);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector(".activity-diff-toggle") as HTMLButtonElement | null;
    expect(button?.textContent).toContain("View changes");
    expect(fixture.nativeElement.querySelector(".description-diff-modal")).toBeNull();

    button?.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector(".description-diff-modal")?.textContent).toContain("Description changes");
    // Single unified view: old/new lines shown together with −/+ markers, no split/combined toggle.
    expect(fixture.nativeElement.querySelector(".description-diff-view-toggle")).toBeNull();
    const unified = fixture.nativeElement.querySelector(".description-diff-unified") as HTMLElement | null;
    expect(unified?.textContent).toContain("−");
    expect(unified?.textContent).toContain("+");
    expect(unified?.textContent).toContain("Hello world");
    expect(unified?.textContent).toContain("Hello brave world");

    (fixture.nativeElement.querySelector(".description-diff-modal .ghost.icon") as HTMLButtonElement | null)?.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(".description-diff-modal")).toBeNull();
  });

  it("does not render a description diff button for legacy description activity", () => {
    const fixture = TestBed.createComponent(CardActivityComponent);

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    fixture.componentInstance.feedItems.set([{ type: "activity", data: createActivity({ payload: { description: "Updated" } }) }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector(".activity-diff-toggle")).toBeNull();
  });

  it("does not render a description diff button when the description is captured for the first time", () => {
    const fixture = TestBed.createComponent(CardActivityComponent);

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    fixture.componentInstance.feedItems.set([{
      type: "activity",
      data: createActivity({
        payload: {
          description: "Fresh notes",
          fromValue: null,
          toValue: "Fresh notes",
        },
      }),
    }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector(".activity-diff-toggle")).toBeNull();
  });

  it("does not render a description diff button when the previous description was blank", () => {
    const fixture = TestBed.createComponent(CardActivityComponent);

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    fixture.componentInstance.feedItems.set([{
      type: "activity",
      data: createActivity({
        payload: {
          description: "Fresh notes",
          fromValue: "  \n\t",
          toValue: "Fresh notes",
        },
      }),
    }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector(".activity-diff-toggle")).toBeNull();
  });

  it("labels formatting-only description edits instead of hiding them", () => {
    const fixture = TestBed.createComponent(CardActivityComponent);

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    fixture.componentInstance.feedItems.set([{
      type: "activity",
      data: createActivity({
        payload: {
          description: "Same _content_",
          fromValue: "Same **content**",
          toValue: "Same _content_\n\n",
        },
      }),
    }]);
    fixture.detectChanges();

    // Text content is unchanged but markdown formatting changed: the button stays and the
    // modal explains it rather than leaving "updated the description" unexplained.
    const button = fixture.nativeElement.querySelector(".activity-diff-toggle") as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    button?.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(".description-diff-note")?.textContent).toContain("Only cosmetic formatting changed");
    expect(fixture.nativeElement.querySelector(".description-diff-unified")).toBeNull();
  });

  it("renders coalesced description activity wording with the net diff", () => {
    const fixture = TestBed.createComponent(CardActivityComponent);
    const activity = createActivity({
      coalescedCount: 3,
      payload: {
        description: "Final copy",
        fromValue: "Original copy",
        toValue: "Final copy",
      },
    });

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    fixture.componentInstance.feedItems.set([{ type: "activity", data: activity }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector(".activity-text")?.textContent?.trim()).toContain("updated the description 3 times");
    (fixture.nativeElement.querySelector(".activity-diff-toggle") as HTMLButtonElement | null)?.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(".description-diff-modal")?.textContent).toContain("Original copy");
    expect(fixture.nativeElement.querySelector(".description-diff-modal")?.textContent).toContain("Final copy");
  });

  it("renders self-assignment activity without repeating the actor name", () => {
    const fixture = TestBed.createComponent(CardActivityComponent);
    const activity = createActivity({
      actorId: "user-2",
      actorKind: "user",
      actorName: "Amelia Hart",
      action: "assignees:set",
      payload: {
        fromValue: [],
        toValue: ["user-2"],
        assigneeNamesById: { "user-2": "Amelia Hart" },
      },
    });

    expect(fixture.componentInstance.activityText(activity)).toBe(" assigned themself");

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    fixture.componentInstance.feedItems.set([{ type: "activity", data: activity }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector(".activity-text")?.textContent?.trim()).toBe("Amelia Hart assigned themself");
  });

  it("passes board-access members into the description editor for mentions", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);
    const members = [{
      userId: "user-2",
      displayName: "Ada Lovelace",
      avatarUrl: null,
      role: "editor" as const,
      source: "workspace" as const,
    }];

    fixture.componentRef.setInput("card", createCard({ description: "Existing" }));
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", members);
    fixture.detectChanges();

    fixture.componentInstance.startEditDescription();
    fixture.detectChanges();

    const editor = fixture.debugElement.query((de) => de.componentInstance instanceof DescriptionEditorComponent)
      .componentInstance as DescriptionEditorComponent;
    expect(editor.mentionMembers()).toEqual(members);
  });

  it("updates edit affordances when the viewer role changes while detail is open", () => {
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector(".due-add-btn")).not.toBeNull();

    viewerRole.set("observer");
    fixture.detectChanges();
    expect(element.querySelector(".due-add-btn")).toBeNull();
    expect(element.querySelector(".due-date-row")?.textContent).toContain("No due date");

    viewerRole.set("editor");
    fixture.detectChanges();
    expect(element.querySelector(".due-add-btn")).not.toBeNull();
  });

  it("does not submit stale removed assignee ids when assigning from card detail", async () => {
    const state = TestBed.inject(BoardState);
    state.viewerRole.set("editor");
    const fixture = TestBed.createComponent(CardDetailComponent);
    const members: WireBoardMemberUser[] = [
      { userId: "user-1", displayName: "Owner", avatarUrl: null, role: "editor", source: "workspace" },
      { userId: "user-2", displayName: "Ada Lovelace", avatarUrl: null, role: "editor", source: "workspace" },
    ];

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", members);
    fixture.componentRef.setInput("assigneeIds", ["removed-user", "user-1"]);
    fixture.detectChanges();

    await fixture.componentInstance.toggleAssignee("user-2");

    expect(api.put).toHaveBeenCalledWith("/cards/card-1/assignees", { userIds: ["user-1", "user-2"] });
  });

  it("auto-opens a recovered card description draft and clears it after save", async () => {
    const key = "card-description:user-1:card-1";
    localStorage.setItem(STORAGE_KEYS.EDITOR_DRAFTS, JSON.stringify({
      [key]: {
        key,
        userId: "user-1",
        kind: "card-description",
        entityId: "card-1",
        cardId: "card-1",
        markdown: "Recovered description",
        baseMarkdown: "Saved description",
        updatedAt: new Date().toISOString(),
      },
    }));
    api.patch.mockResolvedValueOnce(createCard({ description: "Recovered description" }));

    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard({ description: "Saved description" }));
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    expect(fixture.componentInstance.editingDescription()).toBe(true);
    expect(fixture.componentInstance.editorInitialValue()).toBe("Recovered description");
    expect(fixture.nativeElement.textContent).toContain("Unsaved draft.");

    await fixture.componentInstance.onSaveDescription({ markdown: "Recovered description", attachmentIds: [] });

    expect(localStorage.getItem(STORAGE_KEYS.EDITOR_DRAFTS)).toBe("{}");
  });

  it("saves a card description as a local draft when save is pressed offline", async () => {
    // Detail is unloaded on open (default), so the card summary's description is the draft baseline.
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard({ description: "Saved description" }));
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    fixture.componentInstance.startEditDescription();
    canEditLive.set(false);
    await fixture.componentInstance.onSaveDescription({ markdown: "Offline description", attachmentIds: [] });

    const store = JSON.parse(localStorage.getItem(STORAGE_KEYS.EDITOR_DRAFTS) ?? "{}") as Record<string, { markdown?: string; baseMarkdown?: string }>;
    expect(api.patch).not.toHaveBeenCalled();
    expect(fixture.componentInstance.editingDescription()).toBe(false);
    expect(fixture.componentInstance.recoveredDescriptionDraft()).toBe(true);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("Offline description");
    expect(root.querySelector("k-draft-banner")).not.toBeNull();
    expect(root.textContent).toContain("Saved as draft. Reconnect to publish.");
    expect(store["card-description:user-1:card-1"]).toEqual(expect.objectContaining({
      markdown: "Offline description",
      baseMarkdown: "Saved description",
    }));

    canEditLive.set(true);
    fixture.detectChanges();
    root.querySelector<HTMLElement>(".description-viewer-wrap")?.click();
    expect(fixture.componentInstance.editingDescription()).toBe(true);
    expect(fixture.componentInstance.editorInitialValue()).toBe("Offline description");
  });

  it("preserves and closes an open card description editor when the card goes offline", async () => {
    // Detail is unloaded on open (default), so the card summary's description is the draft baseline.
    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard({ description: "Saved description" }));
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    fixture.componentInstance.startEditDescription();
    fixture.componentInstance.onDescriptionDraftChange("Offline description");
    canEditLive.set(false);
    fixture.detectChanges();

    await vi.waitFor(() => expect(fixture.componentInstance.editingDescription()).toBe(false));

    const store = JSON.parse(localStorage.getItem(STORAGE_KEYS.EDITOR_DRAFTS) ?? "{}") as Record<string, { markdown?: string; baseMarkdown?: string }>;
    expect(fixture.componentInstance.recoveredDescriptionDraft()).toBe(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("Offline description");
    expect(store["card-description:user-1:card-1"]).toEqual(expect.objectContaining({
      markdown: "Offline description",
      baseMarkdown: "Saved description",
    }));
  });

  it("shows the detail-body skeleton until /detail resolves, then reveals the body at once", async () => {
    // Mirrors a first open: no cached detail, so the header shows immediately while the
    // detail-dependent body (here a custom field) stays behind the skeleton until /detail lands.
    const detail = deferred<WireCardDetail>();
    api.get.mockImplementation((path: string) =>
      path.endsWith("/detail")
        ? detail.promise
        : path === "/workspaces/workspace-1"
          ? Promise.resolve({ checklistTemplates: [] })
          : Promise.resolve({ items: [], nextCursor: null }),
    );

    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", [createCustomField({ id: "field-1", type: "text" })]);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    // Header is present; the body is a skeleton, not the "No custom fields"-style empties.
    expect(root.querySelector(".card-title")?.textContent).toContain("Ship realtime tests");
    expect(root.querySelector(".detail-body-skeleton")).not.toBeNull();
    expect(root.querySelector(".cf-input")).toBeNull();

    detail.resolve(createCardDetail());
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector(".cf-input")).not.toBeNull();
    });
    expect(root.querySelector(".detail-body-skeleton")).toBeNull();
  });

  it("shows an inline error with retry when /detail fails and no detail is cached", async () => {
    api.get.mockImplementation((path: string) =>
      path.endsWith("/detail")
        ? Promise.reject(new ApiError(500, {}))
        : path === "/workspaces/workspace-1"
          ? Promise.resolve({ checklistTemplates: [] })
          : Promise.resolve({ items: [], nextCursor: null }),
    );

    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", [createCustomField({ id: "field-1", type: "text" })]);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector(".detail-body-error")).not.toBeNull();
    });
    // The header stays usable; only the detail-dependent body reports the failure.
    expect(root.querySelector(".card-title")).not.toBeNull();
    expect(root.querySelector(".detail-body-error")?.textContent).toContain("Couldn't load card details");

    // Retrying after the network recovers hydrates the body.
    api.get.mockImplementation((path: string) =>
      path.endsWith("/detail")
        ? Promise.resolve(createCardDetail())
        : path === "/workspaces/workspace-1"
          ? Promise.resolve({ checklistTemplates: [] })
          : Promise.resolve({ items: [], nextCursor: null }),
    );
    root.querySelector<HTMLButtonElement>(".detail-body-error button")?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector(".cf-input")).not.toBeNull();
    });
    expect(root.querySelector(".detail-body-error")).toBeNull();
  });

  it("does not let a stale /detail response revert a realtime mutation that landed mid-fetch", async () => {
    const refreshDetail = deferred<WireCardDetail>();
    // The initial open may fetch /detail more than once; let all those resolve immediately, and only
    // hand back the controllable deferred once we've armed the background-refresh phase.
    let deferRefresh = false;
    api.get.mockImplementation((path: string) => {
      if (path.endsWith("/detail")) return deferRefresh ? refreshDetail.promise : Promise.resolve(createCardDetail());
      if (path === "/workspaces/workspace-1") return Promise.resolve({ checklistTemplates: [] });
      return Promise.resolve({ items: [], nextCursor: null });
    });

    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    await settleDetail(fixture);
    expect(boardStateDetail()).not.toBeNull();

    // Trigger a background refresh (as a reconnect would), which re-fetches /detail.
    deferRefresh = true;
    fixture.componentInstance.retryDetail();

    // A realtime label/assignee/etc. event lands while that refresh is in flight: BoardState records
    // the mutation (bumping the revision) and now holds the newer detail.
    const newer = createCardDetail({ card: createCard({ description: "Newer realtime body" }) });
    boardStateDetail.set(newer);
    (TestBed.inject(BoardState) as unknown as { noteCardDetailRealtimeMutation: (id: string) => void })
      .noteCardDetailRealtimeMutation("card-1");

    // The stale response (built before the realtime event) resolves — it must not be mirrored back.
    refreshDetail.resolve(createCardDetail({ card: createCard({ description: "Stale response body" }) }));
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(boardStateDetail()).toBe(newer);
    expect(boardStateDetail()?.card.description).toBe("Newer realtime body");
  });

  it("retries an initial /detail load when realtime mutates the card mid-fetch", async () => {
    const initialDetail = deferred<WireCardDetail>();
    const freshDetail = createCardDetail({ card: createCard({ description: "Fresh after realtime" }) });
    let detailRequests = 0;
    api.get.mockImplementation((path: string) => {
      if (path.endsWith("/detail")) {
        detailRequests += 1;
        return detailRequests === 1 ? initialDetail.promise : Promise.resolve(freshDetail);
      }
      if (path === "/workspaces/workspace-1") return Promise.resolve({ checklistTemplates: [] });
      return Promise.resolve({ items: [], nextCursor: null });
    });

    const fixture = TestBed.createComponent(CardDetailComponent);
    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    // No detail is hydrated yet. A socket mutation makes the first response stale before it lands.
    (TestBed.inject(BoardState) as unknown as { noteCardDetailRealtimeMutation: (id: string) => void })
      .noteCardDetailRealtimeMutation("card-1");
    initialDetail.resolve(createCardDetail({ card: createCard({ description: "Stale initial body" }) }));

    await vi.waitFor(() => expect(detailRequests).toBe(2));
    await vi.waitFor(() => expect(boardStateDetail()).toBe(freshDetail));
    expect(boardStateDetail()?.card.description).toBe("Fresh after realtime");
  });

  it("saves text custom fields when the input blurs", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", [createCustomField({ id: "field-1", type: "text" })]);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    await settleDetail(fixture);

    const input = fixture.nativeElement.querySelector(".cf-input") as HTMLInputElement;
    input.value = "High";
    input.dispatchEvent(new Event("blur"));

    await vi.waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("/cards/card-1/custom-fields/field-1", { valueText: "High" });
    });
  });

  it("saves text custom fields on Enter without duplicating the following blur", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", [createCustomField({ id: "field-1", type: "text" })]);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    await settleDetail(fixture);

    const input = fixture.nativeElement.querySelector(".cf-input") as HTMLInputElement;
    input.value = "High";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event("blur"));

    await vi.waitFor(() => {
      expect(api.put).toHaveBeenCalledTimes(1);
      expect(api.put).toHaveBeenCalledWith("/cards/card-1/custom-fields/field-1", { valueText: "High" });
    });
  });

  it("saves rounded decimal number custom fields when the input blurs", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", [createCustomField({ id: "field-1", type: "number" })]);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    await settleDetail(fixture);

    const input = fixture.nativeElement.querySelector(".cf-input") as HTMLInputElement;
    expect(input.step).toBe("any");
    input.value = "8.236";
    input.dispatchEvent(new Event("blur"));

    await vi.waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("/cards/card-1/custom-fields/field-1", { valueNumber: "8.24" });
    });
  });

  it("saves URL custom fields on Enter without duplicating the following blur", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", [createCustomField({ id: "field-1", type: "url" })]);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    await settleDetail(fixture);

    const input = fixture.nativeElement.querySelector(".cf-input") as HTMLInputElement;
    input.value = " https://kanera.test ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event("blur"));

    await vi.waitFor(() => {
      expect(api.put).toHaveBeenCalledTimes(1);
      expect(api.put).toHaveBeenCalledWith("/cards/card-1/custom-fields/field-1", { valueUrl: "https://kanera.test" });
    });
  });

  it("clears custom fields when an empty input blurs", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", [createCustomField({ id: "field-1", type: "text" })]);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    await settleDetail(fixture);

    const input = fixture.nativeElement.querySelector(".cf-input") as HTMLInputElement;
    input.value = "";
    input.dispatchEvent(new Event("blur"));

    await vi.waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith("/cards/card-1/custom-fields/field-1");
    });
  });

  it("renders unchecked checkbox custom fields as an unselected Yes control", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", [createCustomField({ id: "field-1", name: "Approved", type: "checkbox", icon: "checkbox" })]);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    await settleDetail(fixture);

    const button = fixture.nativeElement.querySelector(".cf-checkbox-btn") as HTMLButtonElement;

    expect(button.textContent?.trim()).toBe("Yes");
    expect(button.classList.contains("checked")).toBe(false);
    expect(button.querySelector(".ti-square")).not.toBeNull();
    expect(button.querySelector(".ti-checkbox")).toBeNull();

    button.click();

    await vi.waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("/cards/card-1/custom-fields/field-1", { valueCheckbox: true });
    });
  });

  it("renders checked checkbox custom fields as a selected Yes control", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", [createCustomField({ id: "field-1", name: "Approved", type: "checkbox", icon: "checkbox" })]);
    fixture.componentRef.setInput("customFieldValues", [createCustomFieldValue({ valueCheckbox: true })]);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    await settleDetail(fixture);

    const button = fixture.nativeElement.querySelector(".cf-checkbox-btn") as HTMLButtonElement;

    expect(button.textContent?.trim()).toBe("Yes");
    expect(button.classList.contains("checked")).toBe(true);
    expect(button.querySelector(".ti-checkbox")).not.toBeNull();
    expect(button.querySelector(".ti-square")).toBeNull();

    button.click();

    await vi.waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("/cards/card-1/custom-fields/field-1", { valueCheckbox: false });
    });
  });

  it("does not mark completed due dates as overdue", () => {
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard({
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "anyTime",
      completedAt: new Date("2026-05-21T10:00:00.000Z"),
    }));
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    expect(fixture.componentInstance.dueDateOverdue()).toBe(false);
  });

  it("focuses the new checklist item input after creating a checklist", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);
    const createdChecklist = createChecklistFixture();
    api.post.mockResolvedValue(createdChecklist);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", []);
    fixture.detectChanges();
    await settleDetail(fixture);

    fixture.componentInstance.startAddChecklist();
    fixture.componentInstance.newChecklistTitle.set(createdChecklist.title);
    const checklistCreated = vi.fn();
    fixture.componentInstance.checklistCreated.subscribe(checklistCreated);

    await fixture.componentInstance.createChecklist();
    fixture.componentRef.setInput("checklists", [createdChecklist]);
    fixture.detectChanges();

    expect(api.post).toHaveBeenCalledWith("/cards/card-1/checklists", { title: createdChecklist.title });
    expect(checklistCreated).toHaveBeenCalledWith(createdChecklist);
    expect(fixture.componentInstance.addingItemChecklistId()).toBe(createdChecklist.id);

    await vi.waitFor(() => {
      const addItemInput = fixture.nativeElement.querySelector(".checklist-add-item input") as HTMLInputElement | null;
      expect(addItemInput).not.toBeNull();
      expect(document.activeElement).toBe(addItemInput);
    });
  });

  it("deletes empty top-level and sub-checklists without confirmation", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);
    const confirm = vi.spyOn(TestBed.inject(ConfirmService), "open").mockResolvedValue(false);
    fixture.componentRef.setInput("card", createCard());

    await fixture.componentInstance.deleteChecklist(createChecklistFixture());
    await fixture.componentInstance.deleteChecklist(createChecklistFixture({ id: "nested-1", parentItemId: "item-1" }));

    expect(confirm).not.toHaveBeenCalled();
    expect(api.delete).toHaveBeenNthCalledWith(1, "/cards/card-1/checklists/checklist-1");
    expect(api.delete).toHaveBeenNthCalledWith(2, "/cards/card-1/checklists/nested-1");
  });

  it("still confirms before deleting a checklist containing items", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);
    const checklist = createChecklistFixture({ items: [createChecklistItemFixture()] });
    const confirm = vi.spyOn(TestBed.inject(ConfirmService), "open").mockResolvedValue(false);
    fixture.componentRef.setInput("card", createCard());

    await fixture.componentInstance.deleteChecklist(checklist);

    expect(confirm).toHaveBeenCalledWith({
      title: `Delete "${checklist.title}"?`,
      message: "Checklist items will be removed from this card.",
      danger: true,
    });
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("opens item detail and creates a checklist owned by that top-level item", async () => {
    const item = createChecklistItemFixture({
      description: "Item context",
      dueDateLocalDate: "2026-06-01",
      dueDateSlot: "morning",
    });
    const topLevel = createChecklistFixture({ items: [item] });
    const nested = createChecklistFixture({ id: "nested-1", parentItemId: item.id, title: "Nested" });
    const fixture = TestBed.createComponent(CardDetailComponent);
    api.post.mockResolvedValue(nested);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", [topLevel]);
    fixture.detectChanges();
    await settleDetail(fixture);
    fixture.componentRef.setInput("checklists", [topLevel]);

    fixture.componentInstance.openChecklistItemDetail(item);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(".checklist-item-panel")?.textContent).toContain("Item context");
    expect(fixture.nativeElement.querySelector(".checklist-item-panel")?.textContent).toContain("Jun 1");

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".checklist-item-panel-check")?.click();
    await vi.waitFor(() => expect(api.patch).toHaveBeenCalledWith(
      "/cards/card-1/checklists/checklist-1/items/item-1",
      { completed: true },
    ));

    fixture.componentInstance.startAddChecklist(item.id);
    fixture.componentInstance.newChecklistTitle.set("Nested");
    await fixture.componentInstance.createChecklist();

    expect(api.post).toHaveBeenCalledWith("/cards/card-1/checklists", { title: "Nested", parentItemId: item.id });
  });

  it("dims the card and closes item detail when the drawer scrim is clicked", async () => {
    const item = createChecklistItemFixture();
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", [createChecklistFixture({ items: [item] })]);
    fixture.detectChanges();
    await settleDetail(fixture);
    fixture.componentRef.setInput("checklists", [createChecklistFixture({ items: [item] })]);
    fixture.componentInstance.openChecklistItemDetail(item);
    fixture.detectChanges();

    const scrim = fixture.nativeElement.querySelector(".checklist-item-panel-scrim") as HTMLButtonElement | null;
    expect(scrim).not.toBeNull();
    expect(getComputedStyle(scrim!).height).toBe("100%");
    expect(getComputedStyle(scrim!).width).toBe("100%");
    scrim?.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.openChecklistItemId()).toBeNull();
    expect(fixture.nativeElement.querySelector(".checklist-item-panel")).toBeNull();
  });

  it("renders item metadata pickers only inside the open item detail drawer", async () => {
    const item = createChecklistItemFixture({ dueDateLocalDate: "2026-06-01", dueDateSlot: "morning" });
    const checklist = createChecklistFixture({ items: [item] });
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", [checklist]);
    fixture.detectChanges();
    await settleDetail(fixture);
    fixture.componentRef.setInput("checklists", [checklist]);
    fixture.componentInstance.openChecklistItemDetail(item);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const panel = root.querySelector<HTMLElement>(".checklist-item-panel");
    panel?.querySelector<HTMLButtonElement>(".checklist-item-due")?.click();
    fixture.detectChanges();

    expect(root.querySelectorAll("k-date-picker")).toHaveLength(1);
    expect(panel?.querySelector("k-date-picker")).not.toBeNull();

    fixture.componentInstance.checklistItemDueDatePickerId.set(null);
    fixture.detectChanges();
    panel?.querySelector<HTMLButtonElement>(".item-detail-assignee button")?.click();
    fixture.detectChanges();

    expect(root.querySelectorAll("k-member-picker")).toHaveLength(1);
    expect(panel?.querySelector("k-member-picker")).not.toBeNull();
  });

  it("edits the checklist item title from its detail drawer", async () => {
    const item = createChecklistItemFixture();
    const checklist = createChecklistFixture({ items: [item] });
    const fixture = TestBed.createComponent(CardDetailComponent);
    api.patch.mockResolvedValueOnce({ ...item, text: "Updated from detail" });

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", [checklist]);
    fixture.detectChanges();
    await settleDetail(fixture);
    fixture.componentRef.setInput("checklists", [checklist]);
    fixture.componentInstance.openChecklistItemDetail(item);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    root.querySelector<HTMLButtonElement>(".checklist-item-panel-title.is-button")?.click();
    fixture.detectChanges();

    let titleInput = root.querySelector<HTMLInputElement>("input.checklist-item-panel-title");
    expect(titleInput).not.toBeNull();

    titleInput?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.openChecklistItemId()).toBe(item.id);
    expect(fixture.componentInstance.editingItemId()).toBeNull();

    root.querySelector<HTMLButtonElement>(".checklist-item-panel-title.is-button")?.click();
    fixture.detectChanges();
    titleInput = root.querySelector<HTMLInputElement>("input.checklist-item-panel-title");
    titleInput!.value = "Updated from detail";
    titleInput!.dispatchEvent(new Event("input", { bubbles: true }));
    titleInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => expect(api.patch).toHaveBeenCalledWith(
      "/cards/card-1/checklists/checklist-1/items/item-1",
      { text: "Updated from detail" },
    ));
  });

  it("deletes the checklist item from its detail drawer and closes it", async () => {
    const item = createChecklistItemFixture();
    const checklist = createChecklistFixture({ items: [item] });
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", [checklist]);
    fixture.detectChanges();
    await settleDetail(fixture);
    fixture.componentRef.setInput("checklists", [checklist]);
    fixture.componentInstance.openChecklistItemDetail(item);
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".checklist-item-panel-delete")?.click();

    await vi.waitFor(() => expect(api.delete).toHaveBeenCalledWith(
      "/cards/card-1/checklists/checklist-1/items/item-1",
    ));
    fixture.detectChanges();
    expect(fixture.componentInstance.openChecklistItemId()).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector(".checklist-item-panel")).toBeNull();
  });

  it("confirms before deleting an item that contains detail content", async () => {
    const item = createChecklistItemFixture({ description: "Do not lose this context" });
    const checklist = createChecklistFixture({ items: [item] });
    const nested = createChecklistFixture({ id: "nested-1", parentItemId: item.id });
    const fixture = TestBed.createComponent(CardDetailComponent);
    const confirm = vi.spyOn(TestBed.inject(ConfirmService), "open")
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", [checklist, nested]);
    fixture.detectChanges();
    await settleDetail(fixture);
    fixture.componentRef.setInput("checklists", [checklist, nested]);
    fixture.componentInstance.openChecklistItemDetail(item);
    fixture.detectChanges();

    const deleteButton = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".checklist-item-panel-delete");
    deleteButton?.click();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(api.delete).not.toHaveBeenCalled();
    expect(fixture.componentInstance.openChecklistItemId()).toBe(item.id);

    deleteButton?.click();
    await vi.waitFor(() => expect(api.delete).toHaveBeenCalledWith(
      "/cards/card-1/checklists/checklist-1/items/item-1",
    ));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(fixture.componentInstance.openChecklistItemId()).toBeNull();
  });

  it("persists checklist item description drafts and guards every drawer close path", async () => {
    const item = createChecklistItemFixture({ description: "Published description" });
    const checklist = createChecklistFixture({ items: [item] });
    const fixture = TestBed.createComponent(CardDetailComponent);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", [checklist]);
    fixture.detectChanges();
    await settleDetail(fixture);
    fixture.componentRef.setInput("checklists", [checklist]);
    fixture.componentInstance.openChecklistItemDetail(item);
    fixture.detectChanges();
    fixture.componentInstance.startEditChecklistItemDescription();
    fixture.detectChanges();

    fixture.componentInstance.checklistItemDescriptionEditor()?.setMarkdown("Local item draft");
    fixture.detectChanges();

    const drafts = JSON.parse(localStorage.getItem(STORAGE_KEYS.EDITOR_DRAFTS) ?? "{}") as Record<string, { markdown?: string; baseMarkdown?: string }>;
    expect(drafts["checklist-item-description:user-1:item-1"]).toEqual(expect.objectContaining({
      markdown: "Local item draft",
      baseMarkdown: "Published description",
    }));
    expect(TestBed.inject(UnsavedWorkService).hasUnsavedWork()).toBe(true);

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".checklist-item-panel-scrim")?.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.openChecklistItemId()).toBe(item.id);

    fixture.componentInstance.onDocumentKeydown(new KeyboardEvent("keydown", { key: "Escape" }));
    fixture.detectChanges();
    expect(fixture.componentInstance.openChecklistItemId()).toBeNull();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(api.patch).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.EDITOR_DRAFTS)).toContain("Local item draft");
  });

  it("closing a clean checklist item drawer ignores unrelated unsaved editors", async () => {
    const item = createChecklistItemFixture({ description: "Published description" });
    const checklist = createChecklistFixture({ items: [item] });
    const fixture = TestBed.createComponent(CardDetailComponent);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", [checklist]);
    fixture.detectChanges();
    await settleDetail(fixture);
    fixture.componentRef.setInput("checklists", [checklist]);
    // Open the item drawer but never edit its description, so the drawer itself is clean.
    fixture.componentInstance.openChecklistItemDetail(item);
    fixture.detectChanges();

    // An unrelated editor elsewhere on the card (e.g. the card description) is dirty. Closing the
    // clean drawer must not prompt on its behalf — only the card/route-level checks own that.
    TestBed.inject(UnsavedWorkService).setDirty(Symbol("card-description-editor"), true);
    confirm.mockClear();

    fixture.componentInstance.closeChecklistItemDetail();
    fixture.detectChanges();

    expect(confirm).not.toHaveBeenCalled();
    expect(fixture.componentInstance.openChecklistItemId()).toBeNull();
  });

  it("recovers and publishes a checklist item description draft", async () => {
    const item = createChecklistItemFixture({ description: "Published description" });
    const checklist = createChecklistFixture({ items: [item] });
    const key = "checklist-item-description:user-1:item-1";
    localStorage.setItem(STORAGE_KEYS.EDITOR_DRAFTS, JSON.stringify({
      [key]: {
        key,
        userId: "user-1",
        kind: "checklist-item-description",
        entityId: item.id,
        cardId: "card-1",
        markdown: "Recovered item draft",
        baseMarkdown: "Published description",
        updatedAt: new Date().toISOString(),
      },
    }));
    const updated = { ...item, description: "Recovered item draft" };
    api.patch.mockResolvedValueOnce(updated);
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", [checklist]);
    fixture.detectChanges();
    await settleDetail(fixture);
    fixture.componentRef.setInput("checklists", [checklist]);
    fixture.componentInstance.openChecklistItemDetail(item);
    fixture.detectChanges();

    expect(fixture.componentInstance.editingChecklistItemDescription()).toBe(true);
    expect(fixture.componentInstance.checklistItemDescriptionInitialValue()).toBe("Recovered item draft");
    expect((fixture.nativeElement as HTMLElement).textContent).toContain("Unsaved draft.");

    await fixture.componentInstance.saveChecklistItemDescription({ markdown: "Recovered item draft", attachmentIds: [] });

    expect(api.patch).toHaveBeenCalledWith("/cards/card-1/checklists/checklist-1/items/item-1", {
      description: "Recovered item draft",
    });
    expect(localStorage.getItem(STORAGE_KEYS.EDITOR_DRAFTS)).toBe("{}");
    expect(fixture.componentInstance.recoveredChecklistItemDescriptionDraft()).toBe(false);
  });

  it("lets observers read checklist item detail without exposing edit controls", async () => {
    viewerRole.set("observer");
    canEditLive.set(false);
    const item = createChecklistItemFixture({
      description: "Observer-visible context",
      dueDateLocalDate: "2026-06-01",
      dueDateSlot: "morning",
    });
    const nested = createChecklistFixture({
      id: "nested-1",
      parentItemId: item.id,
      title: "Observer-visible nested checklist",
      items: [createChecklistItemFixture({ id: "nested-item-1", checklistId: "nested-1", text: "Read-only sub-item" })],
    });
    const topLevel = createChecklistFixture({ items: [item] });
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", [topLevel, nested]);
    fixture.detectChanges();
    await settleDetail(fixture);
    fixture.componentRef.setInput("checklists", [topLevel, nested]);
    fixture.detectChanges();

    const detailButton = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".checklist-item-detail");
    expect(detailButton?.disabled).toBe(false);
    expect(detailButton?.textContent).toContain("0/1");
    expect(detailButton?.querySelector(".ti-align-left")).not.toBeNull();
    detailButton?.click();
    fixture.detectChanges();

    const panel = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(".checklist-item-panel");
    expect(panel?.textContent).toContain("Observer-visible context");
    expect(panel?.textContent).toContain("Jun 1");
    expect(panel?.textContent).toContain("Observer-visible nested checklist");
    expect(panel?.textContent).toContain("Read-only sub-item");
    expect(panel?.querySelector(".checklist-hide-toggle")).not.toBeNull();
    expect(panel?.querySelector("k-description-editor")).toBeNull();
    expect(panel?.querySelector(".checklist-add-btn")).toBeNull();
    expect(panel?.querySelector<HTMLButtonElement>(".checklist-check")?.disabled).toBe(true);

    panel?.querySelector<HTMLElement>(".description-viewer-wrap")?.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.editingChecklistItemDescription()).toBe(false);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("shows the checklist template action when editable workspace templates exist", async () => {
    const template = createChecklistTemplateFixture();
    boardChecklistTemplates.set([template]);
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", []);
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      const button = fixture.nativeElement.querySelector(".checklist-template-wrap .checklist-add-btn") as HTMLButtonElement | null;
      expect(button?.textContent).toContain("Add from template");
      expect(button?.disabled).toBe(false);
    });
  });

  it("applies a checklist template and emits created checklists", async () => {
    const template = createChecklistTemplateFixture();
    const checklist = createChecklistFixture({ id: "checklist-template-1", title: template.title });
    const fixture = TestBed.createComponent(CardDetailComponent);
    api.post.mockResolvedValue({ checklists: [checklist], skippedTemplateIds: [] });

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", []);
    fixture.detectChanges();
    const checklistCreated = vi.fn();
    fixture.componentInstance.checklistCreated.subscribe(checklistCreated);

    await fixture.componentInstance.applyChecklistTemplate(template);

    expect(api.post).toHaveBeenCalledWith("/cards/card-1/checklist-templates/apply", { templateIds: [template.id] });
    expect(checklistCreated).toHaveBeenCalledWith(checklist);
    expect(fixture.componentInstance.isChecklistTemplateApplied(template.id)).toBe(true);
  });

  it("does not offer or apply already-applied checklist templates", async () => {
    const template = createChecklistTemplateFixture();
    boardChecklistTemplates.set([template]);
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", []);
    fixture.componentRef.setInput("appliedChecklistTemplateIds", [template.id]);
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      const button = fixture.nativeElement.querySelector(".checklist-template-wrap .checklist-add-btn") as HTMLButtonElement | null;
      expect(button?.disabled).toBe(true);
    });

    await fixture.componentInstance.applyChecklistTemplate(template);

    expect(api.post).not.toHaveBeenCalledWith("/cards/card-1/checklist-templates/apply", { templateIds: [template.id] });
  });

  it("bulk assigns every checklist item, including completed items hidden by the filter", async () => {
    const itemA = createChecklistItemFixture({ id: "item-1", assigneeId: null });
    const itemB = createChecklistItemFixture({ id: "item-2", assigneeId: "user-2", completedAt: new Date("2026-05-21T01:00:00.000Z") });
    const checklist = createChecklistFixture({ items: [itemA, itemB] });
    const fixture = TestBed.createComponent(CardDetailComponent);
    const boardState = TestBed.inject(BoardState) as unknown as { updateChecklistItem: ReturnType<typeof vi.fn> };
    api.patch.mockResolvedValue({});

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", [checklist]);
    fixture.detectChanges();
    fixture.componentInstance.hideCompletedChecklistItems.set(true);
    api.patch.mockResolvedValue({
      items: [
        { ...itemA, assigneeId: "user-3" },
        { ...itemB, assigneeId: "user-3" },
      ],
    });

    await fixture.componentInstance.bulkSetChecklistItemAssignee(checklist, "user-3");

    expect(api.patch).toHaveBeenCalledWith("/cards/card-1/checklists/checklist-1/items/bulk", { assigneeId: "user-3" });
    expect(boardState.updateChecklistItem).toHaveBeenCalledWith("card-1", "checklist-1", expect.objectContaining({ id: "item-1", assigneeId: "user-3" }));
    expect(boardState.updateChecklistItem).toHaveBeenCalledWith("card-1", "checklist-1", expect.objectContaining({ id: "item-2", assigneeId: "user-3" }));
  });

  it("names the assignee in the checklist item unassign tooltip", async () => {
    vi.useFakeTimers();
    const assignee = {
      userId: "user-2",
      displayName: "Ada Lovelace",
      avatarUrl: null,
      role: "editor" as const,
      source: "workspace" as const,
    };
    const checklist = createChecklistFixture({
      items: [createChecklistItemFixture({ assigneeId: assignee.userId })],
    });
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", [assignee]);
    fixture.componentRef.setInput("checklists", [checklist]);
    fixture.detectChanges();
    await settleDetail(fixture);

    const button = fixture.nativeElement.querySelector(".checklist-item-assignee") as HTMLButtonElement;
    button.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(300);
    fixture.detectChanges();

    expect(document.querySelector(".k-tooltip")?.textContent).toBe("Unassign Ada Lovelace");
  });

  it("shows only the unassign tooltip for clickable card assignees", () => {
    vi.useFakeTimers();
    const assignee = {
      userId: "user-2",
      displayName: "Ada Lovelace",
      avatarUrl: null,
      role: "editor" as const,
      source: "workspace" as const,
    };
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("assigneeIds", [assignee.userId]);
    fixture.componentRef.setInput("members", [assignee]);
    fixture.componentRef.setInput("checklists", []);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector(".member-avatar") as HTMLButtonElement;
    const avatarBody = button.querySelector(".avatar-body") as HTMLElement;
    avatarBody.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(300);
    fixture.detectChanges();

    expect(document.querySelector(".k-tooltip")).toBeNull();

    button.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(300);
    fixture.detectChanges();

    expect(document.querySelector(".k-tooltip")?.textContent).toBe("Unassign Ada Lovelace");
  });

  it("bulk sets a due date on every checklist item", async () => {
    const itemA = createChecklistItemFixture({ id: "item-1", dueDateLocalDate: null });
    const itemB = createChecklistItemFixture({ id: "item-2", dueDateLocalDate: "2026-05-20", dueDateSlot: "morning" });
    const checklist = createChecklistFixture({ items: [itemA, itemB] });
    const fixture = TestBed.createComponent(CardDetailComponent);
    api.patch.mockResolvedValue({});

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("checklists", [checklist]);
    fixture.detectChanges();
    api.patch.mockResolvedValue({
      items: [
        { ...itemA, dueDateLocalDate: "2026-06-01", dueDateSlot: "afternoon" },
        { ...itemB, dueDateLocalDate: "2026-06-01", dueDateSlot: "afternoon" },
      ],
    });

    await fixture.componentInstance.bulkSetChecklistItemDueDate(checklist, "2026-06-01", "afternoon");

    expect(api.patch).toHaveBeenCalledWith("/cards/card-1/checklists/checklist-1/items/bulk", { dueDateLocalDate: "2026-06-01", dueDateSlot: "afternoon" });
  });

  it("renders deferred activity after switching to the comments tab", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const commentsTab = Array.from(root.querySelectorAll(".tab-btn"))
      .find((button) => button.textContent?.includes("Activity")) as HTMLButtonElement | undefined;

    expect(commentsTab).toBeDefined();
    commentsTab?.click();
    fixture.detectChanges();

    await vi.waitFor(() => {
      expect(fixture.nativeElement.querySelector("k-card-activity")).not.toBeNull();
    });
  });

  it("renders deferred activity in wide two-column layouts without switching tabs", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    expect(fixture.componentInstance.activeTab()).toBe("detail");
    expect(fixture.nativeElement.querySelector("k-card-activity")).toBeNull();

    const observer = ResizeObserverStub.instances.at(-1);
    expect(observer).toBeDefined();
    observer?.trigger(900);
    fixture.detectChanges();

    await vi.waitFor(() => {
      expect(fixture.nativeElement.querySelector("k-card-activity")).not.toBeNull();
    });
  });

  it("names the owning item when a nested sub-checklist is completed", () => {
    const fixture = TestBed.createComponent(CardActivityComponent);
    const text = fixture.componentInstance.activityText(createActivity({
      action: "checklist:completed",
      payload: {
        checklistId: "nested-1",
        title: "Final checks",
        parentItemId: "item-1",
        parentItemText: "Ship release",
        fromValue: false,
        toValue: true,
      },
    }));

    expect(text).toContain("completed sub-checklist");
    expect(text).toContain("Final checks");
    expect(text).toContain("on");
    expect(text).toContain("Ship release");
  });

  it("replaces and removes realtime activity feed items by id", async () => {
    const fixture = TestBed.createComponent(CardActivityComponent);

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => expect(socketService.connect).toHaveBeenCalledTimes(1));

    socket.trigger("card:feedItem:created", {
      boardId: "board-1",
      cardId: "card-1",
      item: { type: "activity", data: createActivity() },
    });
    socket.trigger("card:feedItem:updated", {
      boardId: "board-1",
      cardId: "card-1",
      item: { type: "activity", data: createActivity({ coalescedCount: 3 }) },
    });

    expect(fixture.componentInstance.feedItems()).toHaveLength(1);
    const [item] = fixture.componentInstance.feedItems();
    expect(item?.type).toBe("activity");
    if (item?.type !== "activity") throw new Error("Expected activity feed item");
    expect(item.data.coalescedCount).toBe(3);

    socket.trigger("card:feedItem:deleted", {
      boardId: "board-1",
      cardId: "card-1",
      type: "activity",
      itemId: "activity-1",
    });

    expect(fixture.componentInstance.feedItems()).toEqual([]);
  });

  it("keeps card-created activity before same-timestamp automation activity", async () => {
    const fixture = TestBed.createComponent(CardActivityComponent);

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => expect(socketService.connect).toHaveBeenCalledTimes(1));

    const createdAt = new Date("2026-05-21T00:00:00.000Z");
    socket.trigger("card:feedItem:created", {
      boardId: "board-1",
      cardId: "card-1",
      item: { type: "activity", data: createActivity({ id: "activity-labels", actorKind: "system", actorName: "Kanera", action: "labels:set", createdAt }) },
    });
    socket.trigger("card:feedItem:created", {
      boardId: "board-1",
      cardId: "card-1",
      item: { type: "activity", data: createActivity({ id: "activity-created", action: "created", createdAt }) },
    });

    expect(fixture.componentInstance.feedItems().map((item) => item.data.id)).toEqual(["activity-created", "activity-labels"]);
  });

  it("filters the feed to comments only", async () => {
    const fixture = TestBed.createComponent(CardActivityComponent);

    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => expect(socketService.connect).toHaveBeenCalledTimes(1));

    socket.trigger("card:feedItem:created", {
      boardId: "board-1",
      cardId: "card-1",
      item: { type: "activity", data: createActivity() },
    });
    socket.trigger("card:feedItem:created", {
      boardId: "board-1",
      cardId: "card-1",
      item: { type: "comment", data: createComment() },
    });

    fixture.componentInstance.feedFilter.set("comments");

    expect(fixture.componentInstance.feedItems()).toHaveLength(2);
    expect(fixture.componentInstance.filteredFeedItems()).toEqual([
      { type: "comment", data: createComment() },
    ]);
  });

  it("hides comment reaction controls for observer viewers", async () => {
    viewerRole.set("observer");

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", false);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => expect(socketService.connect).toHaveBeenCalledTimes(1));

    socket.trigger("card:feedItem:created", {
      boardId: "board-1",
      cardId: "card-1",
      item: {
        type: "comment",
        data: createComment({
          reactions: [{
            type: "thumbs_up",
            count: 1,
            userIds: ["user-3"],
            users: [{ id: "user-3", displayName: "Grace Hopper", avatarUrl: null }],
          }],
        }),
      },
    });
    fixture.detectChanges();

    expect(fixture.componentInstance.canViewReactions()).toBe(false);
    expect(fixture.componentInstance.canReact(createComment())).toBe(false);
    expect(fixture.nativeElement.querySelector(".reaction-chip")).toBeNull();
    expect(fixture.nativeElement.querySelector(".reaction-add")).toBeNull();
  });

  it("loads additional feed pages when the bottom sentinel is reached", async () => {
    const nextPage = deferred<{ items: { type: "comment"; data: WireComment }[]; nextCursor: string | null }>();
    api.get.mockImplementation((path: string) => {
      if (path.endsWith("/detail")) {
        return Promise.resolve({ card: createCard(), customFieldValues: [], labelIds: [], assigneeIds: [], attachments: [], checklists: [], appliedChecklistTemplateIds: [], linkedNotes: [] });
      }
      if (path === "/cards/card-1/feed?limit=50") {
        return Promise.resolve({
          items: [{ type: "activity", data: createActivity({ id: "activity-new" }) }],
          nextCursor: "2026-05-21T00:00:00.000Z",
        });
      }
      if (path === "/cards/card-1/feed?limit=50&cursor=2026-05-21T00%3A00%3A00.000Z") {
        return nextPage.promise;
      }
      return Promise.resolve({ items: [], nextCursor: null });
    });

    const fixture = TestBed.createComponent(CardActivityComponent);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();

    await vi.waitFor(() => expect(fixture.componentInstance.feedHasMore()).toBe(true));
    fixture.detectChanges();

    const sentinel = fixture.nativeElement.querySelector(".feed-scroll-sentinel") as HTMLElement | null;
    expect(sentinel).not.toBeNull();
    await vi.waitFor(() => expect(IntersectionObserverStub.instances.some((observer) => observer.observe.mock.calls.some(([el]) => el === sentinel))).toBe(true));
    const observer = IntersectionObserverStub.instances.find((candidate) => candidate.observe.mock.calls.some(([el]) => el === sentinel));
    observer!.trigger();
    fixture.detectChanges();

    expect(fixture.componentInstance.feedLoadingMore()).toBe(true);
    expect(sentinel!.textContent).toContain("");
    expect(sentinel!.querySelector(".ti-loader-2")).not.toBeNull();
    expect(api.get).toHaveBeenCalledWith("/cards/card-1/feed?limit=50&cursor=2026-05-21T00%3A00%3A00.000Z");

    nextPage.resolve({
      items: [{ type: "comment", data: createComment({ id: "comment-old", createdAt: new Date("2026-05-20T00:00:00.000Z") }) }],
      nextCursor: null,
    });

    await vi.waitFor(() => expect(fixture.componentInstance.feedLoadingMore()).toBe(false));
    expect(fixture.componentInstance.feedHasMore()).toBe(false);
    expect(fixture.componentInstance.feedItems().map((item) => item.data.id)).toEqual(["activity-new", "comment-old"]);
  });

  it("opens the attachment lightbox with all card images at the selected image", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);
    const attachments = [
      createAttachment({
        id: "attachment-1",
        fileName: "first.png",
        url: "https://example.com/first.png",
        thumbnailUrl: "https://example.com/first-thumb.png",
      }),
      createAttachment({
        id: "attachment-2",
        fileName: "notes.pdf",
        mimeType: "application/pdf",
        url: "https://example.com/notes.pdf",
        thumbnailUrl: null,
      }),
      createAttachment({
        id: "attachment-3",
        fileName: "second.jpg",
        mimeType: "image/jpeg",
        url: "https://example.com/second.jpg",
        thumbnailUrl: "https://example.com/second-thumb.jpg",
      }),
    ];

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("attachments", attachments);
    fixture.detectChanges();
    await settleDetail(fixture);

    const imageButtons = Array.from(fixture.nativeElement.querySelectorAll(".attach-thumb.is-image")) as HTMLButtonElement[];
    expect(imageButtons).toHaveLength(2);

    imageButtons[1]?.click();

    expect(imageLightbox.open).toHaveBeenCalledWith({
      src: "https://example.com/second.jpg",
      fileName: "second.jpg",
      createdAt: attachments[2]!.createdAt,
      images: [
        {
          src: "https://example.com/first.png",
          fileName: "first.png",
          createdAt: attachments[0]!.createdAt,
        },
        {
          src: "https://example.com/second.jpg",
          fileName: "second.jpg",
          createdAt: attachments[2]!.createdAt,
        },
      ],
      initialIndex: 1,
    }, expect.any(Event));
  });

  it("opens the requested attachment lightbox from an initial deep link", async () => {
    const fixture = TestBed.createComponent(CardDetailComponent);
    const attachments = [
      createAttachment({
        id: "attachment-1",
        fileName: "first.png",
        url: "https://example.com/first.png",
      }),
      createAttachment({
        id: "attachment-2",
        fileName: "second.jpg",
        mimeType: "image/jpeg",
        url: "https://example.com/second.jpg",
      }),
    ];

    fixture.componentRef.setInput("card", createCard());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("customFieldValues", []);
    fixture.componentRef.setInput("cardLabels", []);
    fixture.componentRef.setInput("cardLabelIds", []);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("attachments", attachments);
    fixture.componentRef.setInput("lightboxAttachmentId", "attachment-2");
    fixture.detectChanges();
    await settleDetail(fixture);

    expect(imageLightbox.open).toHaveBeenCalledWith({
      src: "https://example.com/second.jpg",
      fileName: "second.jpg",
      createdAt: attachments[1]!.createdAt,
      images: [
        {
          src: "https://example.com/first.png",
          fileName: "first.png",
          createdAt: attachments[0]!.createdAt,
        },
        {
          src: "https://example.com/second.jpg",
          fileName: "second.jpg",
          createdAt: attachments[1]!.createdAt,
        },
      ],
      initialIndex: 1,
    }, undefined);
  });
});
