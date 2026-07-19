import { provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router } from "@angular/router";
import { AUTOMATION_ACTION_LIMIT, AUTOMATION_LIMIT } from "@kanera/shared/automation-limits";
import type { AutomationActionBody } from "@kanera/shared/dto";
import type { Board, BoardGroup, List, Workspace, WorkspaceMember } from "@kanera/shared/schema";
import type { WireAutomation, WireCardLabel, WireCustomField } from "@kanera/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import type { AppSocket } from "../../core/realtime/socket.service";
import { SocketService } from "../../core/realtime/socket.service";
import { AppTitleService } from "../../core/title/app-title.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { ConfirmService } from "../../shared/confirm.service";
import { WorkspaceSettingsPage } from "./workspace-settings.page";

class SocketStub {
  private readonly handlers = new Map<string, (...args: unknown[]) => void>();
  readonly on = vi.fn((event: string, handler: (...args: unknown[]) => void) => { this.handlers.set(event, handler); return this; });
  readonly off = vi.fn(() => this);

  trigger(event: string, payload: unknown) { this.handlers.get(event)?.(payload); }

  asSocket(): AppSocket {
    return this as unknown as AppSocket;
  }
}

function workspace(overrides: Partial<Workspace & { role: string }> = {}): Workspace & { role: string } {
  return {
    id: "workspace-1",
    clientId: "client-1",
    name: "Delivery",
    kind: "standard",
    icon: null,
    accentColor: null,
    completedCardsActiveDays: 35,
    boardLinkingEnabled: true,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    archivedAt: null,
    role: "admin",
    ...overrides,
  };
}

function board(overrides: Partial<Board> = {}): Board {
  return {
    id: "board-1",
    workspaceId: "workspace-1",
    groupId: null,
    standaloneGroupId: null,
    name: "Roadmap",
    description: null,
    icon: null,
    iconColor: null,
    backgroundGradient: null,
    position: "1000.0000000000",
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function boardGroup(overrides: Partial<BoardGroup> = {}): BoardGroup {
  return {
    id: "group-1",
    workspaceId: "workspace-1",
    title: "Product",
    position: "1000.0000000000",
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function member(overrides: Partial<WorkspaceMember & { email: string; displayName: string; avatarUrl: string | null; orgRole?: "owner" | "admin" | "member" }> = {}): WorkspaceMember & { email: string; displayName: string; avatarUrl: string | null; orgRole?: "owner" | "admin" | "member" } {
  return {
    workspaceId: "workspace-1",
    userId: "user-1",
    role: "admin",
    addedAt: new Date("2026-05-21T00:00:00.000Z"),
    email: "me@example.com",
    displayName: "Me User",
    avatarUrl: null,
    ...overrides,
  };
}

function automation(overrides: Partial<WireAutomation> = {}): WireAutomation {
  return {
    id: "automation-1",
    workspaceId: "workspace-1",
    enabled: true,
    position: "1000.0000000000",
    triggerType: "card_enters_list",
    triggerListId: "list-1",
    triggerUserIds: null,
    triggerLabelId: null,
    applyOnCreate: true,
    applyOnMove: true,
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    actions: [{
      id: "action-1",
      automationId: "automation-1",
      type: "set_completion",
      config: { completed: true },
      position: "1000.0000000000",
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    }],
    ...overrides,
  };
}

function workspaceList(overrides: Partial<List> = {}): List {
  return {
    id: "list-1",
    workspaceId: "workspace-1",
    name: "Inbox",
    icon: null,
    color: null,
    position: "1000.0000000000",
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function cardLabel(overrides: Partial<WireCardLabel> = {}): WireCardLabel {
  return {
    id: "label-1",
    workspaceId: "workspace-1",
    name: "Urgent",
    color: "red",
    position: "1000.0000000000",
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function automations(count: number): WireAutomation[] {
  return Array.from({ length: count }, (_, index) => automation({
    id: `automation-${index + 1}`,
    position: `${index + 1}000.0000000000`,
  }));
}

function automationActions(count: number): WireAutomation["actions"] {
  return Array.from({ length: count }, (_, index) => ({
    id: `action-${index + 1}`,
    automationId: "automation-1",
    type: "set_completion" as const,
    config: { completed: true },
    position: `${index + 1}000.0000000000`,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
  }));
}

function customField(overrides: Partial<WireCustomField> = {}): WireCustomField {
  return {
    id: "field-1",
    workspaceId: "workspace-1",
    name: "Billing Month",
    icon: "calendar",
    type: "text",
    showOnCard: true,
    allowMultiple: false,
    position: "1000.0000000000",
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    options: [],
    ...overrides,
  };
}

describe("WorkspaceSettingsPage", () => {
  let fixture: ComponentFixture<WorkspaceSettingsPage>;
  let activeSettingsRoute: string;

  async function flushAsyncEffects() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function render(auth: {
    standalone?: boolean;
    maxEnabledAutomations?: number | null;
    confirmResult?: boolean;
    deletionImpactCount?: number;
    boardLinkCount?: number;
    apiKeys?: {
      id: string;
      workspaceId: string;
      createdById: string;
      createdByName: string;
      createdByEmail: string;
      name: string;
      keyPrefix: string;
      scope: "read" | "write" | "admin";
      lastUsedAt: string | Date | null;
      createdAt: string | Date;
    }[];
    webhooks?: {
      id: string;
      workspaceId: string;
      name: string;
      url: string;
      eventTypes: string[];
      enabled: boolean;
      lastSuccessfulAt: string | Date | null;
      createdAt: string | Date;
      updatedAt: string | Date;
    }[];
  } = {}) {
    const group = boardGroup();
    const loadedWorkspace = workspace(auth.standalone ? { kind: "board", name: "Solo Roadmap" } : {});
    const loadedBoard = board(auth.standalone ? { name: "Solo Roadmap", standaloneGroupId: group.id } : { groupId: group.id });
    const socket = new SocketStub();
    let loadedConfirmationMessage: string | null = null;
    const api = {
      get: vi.fn((path: string) => {
        if (path.endsWith("/deletion-impact")) return Promise.resolve({ cardCount: auth.deletionImpactCount ?? 0 });
        if (path.endsWith("/mirror-status")) return Promise.resolve({ count: auth.boardLinkCount ?? 0 });
        if (path === "/boards/board-1") return Promise.resolve(loadedBoard);
        if (path === "/clients/me/standalone-board-groups") return Promise.resolve([
          { id: group.id, clientId: "client-1", title: group.title, createdAt: new Date(), updatedAt: new Date() },
          { id: "standalone-group-2", clientId: "client-1", title: "Operations", createdAt: new Date(), updatedAt: new Date() },
        ]);
        if (path === "/workspaces/workspace-1") return Promise.resolve({ workspace: loadedWorkspace, role: "admin", lists: [], customFields: [], cardLabels: [], checklistTemplates: [], automations: [] });
        if (path === "/workspaces/workspace-1/members") return Promise.resolve([member()]);
        if (path === "/workspaces/workspace-1/member-candidates") return Promise.resolve([]);
        if (path === "/workspaces/workspace-1/boards") return Promise.resolve([loadedBoard]);
        if (path === "/workspaces/workspace-1/board-groups") return Promise.resolve([group]);
        if (path === "/workspaces/workspace-1/api-keys") return Promise.resolve(auth.apiKeys ?? []);
        if (path === "/workspaces/workspace-1/webhooks") return Promise.resolve(auth.webhooks ?? []);
        if (path === "/workspaces/workspace-1/guests") return Promise.resolve({ boards: [], acceptedGuests: [], pendingInvites: [] });
        return Promise.resolve({});
      }),
      patch: vi.fn((path: string, patch: { name?: string; boardLinkingEnabled?: boolean; groupTitle?: string | null }) => {
        if (path === "/boards/board-1") return Promise.resolve(board({ name: patch.name ?? loadedBoard.name }));
        if (path === "/workspaces/workspace-1") return Promise.resolve(workspace({ name: patch.name ?? loadedWorkspace.name, boardLinkingEnabled: patch.boardLinkingEnabled ?? loadedWorkspace.boardLinkingEnabled }));
        return Promise.resolve({});
      }),
      post: vi.fn((path: string) => {
        if (path.endsWith("/guests/seat-preview")) return Promise.resolve({ paidGuestSeatRequired: false, paidGuestSeatActive: false });
        return Promise.resolve({});
      }),
      delete: vi.fn(),
      put: vi.fn(() => Promise.resolve({
        id: "automation-1",
        workspaceId: "workspace-1",
        enabled: true,
        position: "1000.0000000000",
        triggerType: "card_enters_list",
        triggerListId: "list-1",
        triggerUserIds: null,
        triggerLabelId: null,
        applyOnCreate: true,
        applyOnMove: true,
        archivedAt: null,
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z"),
        actions: [],
      } satisfies WireAutomation)),
    };

    await TestBed.configureTestingModule({
      imports: [WorkspaceSettingsPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        { provide: AppTitleService, useValue: { set: vi.fn() } },
        {
          provide: AuthService,
          useValue: {
            user: signal({ id: "user-1", displayName: "Me User" }),
            isOrgAdmin: signal(false),
            guestsAllowed: signal(true),
            apiAllowed: signal(true),
            webhooksAllowed: signal(true),
            maxBoards: signal(null),
            maxOrgMembers: signal(null),
            maxEnabledAutomations: signal(auth.maxEnabledAutomations ?? null),
          },
        },
        {
          provide: ConfirmService,
          useValue: {
            open: vi.fn(() => Promise.resolve(auth.confirmResult ?? true)),
            openAfterLoading: vi.fn(async (_options: unknown, loadMessage: () => Promise<string>) => {
              loadedConfirmationMessage = await loadMessage();
              return auth.confirmResult ?? true;
            }),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            get firstChild() {
              return { snapshot: { url: [{ path: activeSettingsRoute }] } };
            },
          },
        },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: SocketService, useValue: { connect: vi.fn(() => socket.asSocket()), joinWorkspace: vi.fn(() => vi.fn()), displayedOnline: signal(true), reconnecting: signal(false), accessRefreshing: signal(false) } },
        { provide: WorkspaceService, useValue: { setActiveAccentColor: vi.fn(), updateAccentColor: vi.fn() } },
      ],
    }).compileComponents();

    activeSettingsRoute = "boards";
    fixture = TestBed.createComponent(WorkspaceSettingsPage);
    if (auth.standalone) fixture.componentRef.setInput("boardId", "board-1");
    else fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsyncEffects();
    fixture.componentInstance.selectedTab.set("boards");
    fixture.detectChanges();

    return {
      api,
      socket,
      router: TestBed.inject(Router) as unknown as { navigate: ReturnType<typeof vi.fn> },
      group,
      loadedConfirmationMessage: () => loadedConfirmationMessage,
      confirm: TestBed.inject(ConfirmService) as unknown as {
        open: ReturnType<typeof vi.fn>;
        openAfterLoading: ReturnType<typeof vi.fn>;
      },
    };
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps standalone membership management on the board permissions menu", async () => {
    await render();
    const component = fixture.componentInstance;
    component.workspace.set(workspace({ kind: "board" }));

    const tabIds = component.settingsTabs().map((tab) => tab.id);
    expect(tabIds).not.toContain("boards");
    expect(tabIds).not.toContain("members");
    expect(tabIds).toContain("import");
    component.selectTab("members");
    expect(component.selectedTab()).toBe("general");
  });

  it("debounces standalone title edits through the board rename endpoint", async () => {
    const { api } = await render({ standalone: true });
    vi.useFakeTimers();

    fixture.componentInstance.updateWorkspaceName("Solo R");
    fixture.componentInstance.updateWorkspaceName("Solo Roadmap renamed");
    expect(api.patch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(299);
    expect(api.patch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledWith("/boards/board-1", { name: "Solo Roadmap renamed" });
  });

  it("configures an implicit standalone group name on the board General page", async () => {
    const { api } = await render({ standalone: true });
    fixture.componentInstance.selectedTab.set("general");
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsyncEffects();
    fixture.detectChanges();

    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[role="combobox"][aria-controls="standalone-board-group-options"]');
    expect(input?.value).toBe("Product");
    input!.value = "Client work";
    input!.dispatchEvent(new Event("input"));
    input!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await fixture.whenStable();

    expect(api.patch).toHaveBeenCalledWith("/clients/me/standalone-boards/board-1/group", { groupTitle: "Client work" });
  });

  it("selects an existing standalone group from the editable group control", async () => {
    const { api } = await render({ standalone: true });
    fixture.componentInstance.selectedTab.set("general");
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsyncEffects();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('input[role="combobox"][aria-controls="standalone-board-group-options"]')!;
    input.value = "";
    input.dispatchEvent(new Event("input"));
    fixture.detectChanges();

    const operationsOption = [...root.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((option) => option.textContent?.trim() === "Operations");
    operationsOption!.click();
    await fixture.whenStable();

    expect(input.value).toBe("Operations");
    expect(api.patch).toHaveBeenCalledWith("/clients/me/standalone-boards/board-1/group", { groupTitle: "Operations" });
  });

  it("clears the current standalone group from the combobox control", async () => {
    const { api } = await render({ standalone: true });
    fixture.componentInstance.selectedTab.set("general");
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsyncEffects();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('input[role="combobox"][aria-controls="standalone-board-group-options"]')!;
    root.querySelector<HTMLButtonElement>('[aria-label="Remove board from group"]')!.click();
    await fixture.whenStable();

    expect(input.value).toBe("");
    expect(api.patch).toHaveBeenCalledWith("/clients/me/standalone-boards/board-1/group", { groupTitle: null });
  });

  it("offers to create a standalone group when the typed name is new", async () => {
    await render({ standalone: true });
    fixture.componentInstance.selectedTab.set("general");
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsyncEffects();

    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('input[role="combobox"][aria-controls="standalone-board-group-options"]')!;
    input.value = "Client work";
    input.dispatchEvent(new Event("input"));
    fixture.detectChanges();

    expect([...root.querySelectorAll('[role="option"]')].some((option) => option.textContent?.includes('Create “Client work”'))).toBe(true);
  });

  it("closes the standalone group menu when clicking outside the control", async () => {
    await render({ standalone: true });
    fixture.componentInstance.selectedTab.set("general");
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsyncEffects();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('input[role="combobox"][aria-controls="standalone-board-group-options"]')!;
    input.dispatchEvent(new FocusEvent("focus"));
    fixture.detectChanges();
    expect(root.querySelector("#standalone-board-group-options")).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    fixture.detectChanges();

    expect(root.querySelector("#standalone-board-group-options")).toBeNull();
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });

  it("saves a pending standalone title immediately on Enter without a later duplicate", async () => {
    const { api } = await render({ standalone: true });
    vi.useFakeTimers();

    fixture.componentInstance.updateWorkspaceName("Solo Roadmap renamed");
    fixture.componentInstance.saveWorkspaceNameNow();

    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledWith("/boards/board-1", { name: "Solo Roadmap renamed" });
    vi.advanceTimersByTime(300);
    expect(api.patch).toHaveBeenCalledTimes(1);
  });

  it("labels the hidden workspace ID as the standalone board configuration ID", async () => {
    await render();
    const component = fixture.componentInstance;
    component.workspace.set(workspace({ kind: "board" }));
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsyncEffects();
    component.selectedTab.set("api");
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("Board configuration");
    expect(root.querySelector<HTMLButtonElement>('[aria-label="Copy board configuration ID"]')).not.toBeNull();
  });

  it("confirms the exact board-link count before disabling and deleting links", async () => {
    const { api, confirm } = await render({ boardLinkCount: 2 });

    await fixture.componentInstance.updateBoardLinkingEnabled(false);

    expect(api.get).toHaveBeenCalledWith("/workspaces/workspace-1/mirror-status");
    expect(confirm.open).toHaveBeenCalledWith({
      title: "Disable board linking?",
      message: "2 board links will be deleted. This cannot be undone.",
      confirmLabel: "Disable and delete links",
      danger: true,
    });
    expect(api.patch).toHaveBeenCalledWith("/workspaces/workspace-1", { boardLinkingEnabled: false });
    expect(fixture.componentInstance.workspace()?.boardLinkingEnabled).toBe(false);
  });

  it("keeps board linking enabled when destructive confirmation is cancelled", async () => {
    const { api } = await render({ boardLinkCount: 1, confirmResult: false });
    fixture.componentInstance.selectedTab.set("general");
    fixture.detectChanges();
    const checkbox = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(".board-linking-toggle input");
    expect(checkbox?.checked).toBe(true);

    checkbox?.click();
    expect(checkbox?.checked).toBe(false);
    await vi.waitFor(() => expect(checkbox?.checked).toBe(true));

    expect(api.patch).not.toHaveBeenCalled();
    expect(fixture.componentInstance.workspace()?.boardLinkingEnabled).toBe(true);
    expect(fixture.componentInstance.boardLinkingEnabledDraft()).toBe(true);
  });

  it("disables standalone board linking without confirmation when no links exist", async () => {
    const { api, confirm } = await render({ standalone: true, boardLinkCount: 0 });

    await fixture.componentInstance.updateBoardLinkingEnabled(false);

    expect(api.get).toHaveBeenCalledWith("/workspaces/workspace-1/mirror-status");
    expect(confirm.open).not.toHaveBeenCalled();
    expect(api.patch).toHaveBeenCalledWith("/workspaces/workspace-1", { boardLinkingEnabled: false });
  });

  it("asks for confirmation before deleting a workspace from the danger zone", async () => {
    const { api, confirm } = await render({ confirmResult: false });

    await fixture.componentInstance.deleteWorkspace();

    expect(confirm.open).toHaveBeenCalledWith({
      title: 'Are you sure you want to delete workspace "Delivery"?',
      message: "This will permanently delete all boards, lists, and cards inside it.",
      confirmLabel: "Delete workspace",
    });
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("asks for confirmation before deleting a standalone board from the danger zone", async () => {
    const { api, confirm } = await render({ confirmResult: false });
    fixture.componentInstance.workspace.set(workspace({ kind: "board", name: "Solo Roadmap" }));

    await fixture.componentInstance.deleteWorkspace();

    expect(confirm.open).toHaveBeenCalledWith({
      title: 'Are you sure you want to delete board "Solo Roadmap"?',
      message: "This will permanently delete this board, its lists, cards, and settings.",
      confirmLabel: "Delete board",
    });
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("shows the current board group selection for grouped boards", async () => {
    const { group } = await render();

    const select = (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>(".board-group-select");

    expect(select?.value).toBe(group.id);
  });

  it("shows the list card count before deleting a list", async () => {
    const { api, confirm, loadedConfirmationMessage } = await render({ deletionImpactCount: 2 });
    const component = fixture.componentInstance;
    component.lists.set([workspaceList()]);

    await component.archiveList("list-1");

    expect(api.get).toHaveBeenCalledWith("/lists/list-1/deletion-impact");
    expect(confirm.openAfterLoading).toHaveBeenCalledWith({
      title: 'Delete list "Inbox"?',
      loadingMessage: "Checking how many cards will be deleted...",
    }, expect.any(Function));
    expect(loadedConfirmationMessage()).toBe("2 cards will also be permanently deleted. Are you sure?");
    expect(api.delete).toHaveBeenCalledWith("/lists/list-1");
  });

  it("uses singular card wording and does not delete a cancelled board", async () => {
    const { api, confirm, loadedConfirmationMessage } = await render({ confirmResult: false, deletionImpactCount: 1 });

    await fixture.componentInstance.deleteBoard("board-1");

    expect(api.get).toHaveBeenCalledWith("/boards/board-1/deletion-impact");
    expect(confirm.openAfterLoading).toHaveBeenCalledWith({
      title: 'Delete "Roadmap"?',
      loadingMessage: "Checking how many cards will be deleted...",
    }, expect.any(Function));
    expect(loadedConfirmationMessage()).toBe("1 card will also be permanently deleted. Are you sure?");
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("ignores repeated delete clicks while the card count is loading", async () => {
    const { api, confirm } = await render();
    let resolveImpact!: (impact: { cardCount: number }) => void;
    api.get.mockImplementationOnce(() => new Promise((resolve) => { resolveImpact = resolve; }));

    const firstDelete = fixture.componentInstance.deleteBoard("board-1");
    const repeatedDelete = fixture.componentInstance.deleteBoard("board-1");

    expect(confirm.openAfterLoading).toHaveBeenCalledTimes(1);
    expect(api.get.mock.calls.filter(([path]) => path === "/boards/board-1/deletion-impact")).toHaveLength(1);
    await repeatedDelete;
    resolveImpact({ cardCount: 4 });
    await firstDelete;
    expect(api.delete).toHaveBeenCalledTimes(1);
  });

  it("keeps guest board options fresh after creating boards without a reload", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    component.guestBoards.set([]);

    for (let index = 1; index <= 10; index += 1) {
      api.post.mockResolvedValueOnce(board({
        id: `new-board-${index}`,
        name: `Client Board ${index}`,
        position: `${1000 + index}.0000000000`,
      }));
      component.newBoardName.set(`Client Board ${index}`);
      await component.createBoard(new Event("submit"));
    }
    await flushAsyncEffects();

    expect(component.guestBoards().map((item) => item.name)).toEqual([
      "Client Board 1",
      "Client Board 2",
      "Client Board 3",
      "Client Board 4",
      "Client Board 5",
      "Client Board 6",
      "Client Board 7",
      "Client Board 8",
      "Client Board 9",
      "Client Board 10",
    ]);
    expect(component.guestBoardId()).toBe("new-board-1");
  });

  it("shows creator and last-used status for each workspace API key", async () => {
    const lastUsedAt = "2026-07-06T14:14:00.000Z";
    await render({
      apiKeys: [
        {
          id: "api-key-1",
          workspaceId: "workspace-1",
          createdById: "user-2",
          createdByName: "Integration Admin",
          createdByEmail: "integrations-admin@example.com",
          name: "Teammate sync",
          keyPrefix: "kanera_live_abc123",
          scope: "write",
          lastUsedAt,
          createdAt: new Date("2026-05-21T00:00:00.000Z"),
        },
        {
          id: "api-key-2",
          workspaceId: "workspace-1",
          createdById: "user-1",
          createdByName: "Owner User",
          createdByEmail: "owner@example.com",
          name: "Unused import",
          keyPrefix: "kanera_live_def456",
          scope: "read",
          lastUsedAt: null,
          createdAt: new Date("2026-05-22T00:00:00.000Z"),
        },
      ],
    });
    fixture.componentInstance.selectedTab.set("api");
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    const formattedLastUsed = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(lastUsedAt));
    expect(text).toContain("Teammate sync");
    expect(text).toContain("Created by Integration Admin");
    expect(text).toContain("Last used");
    expect(text).toContain(formattedLastUsed);
    expect(text).toContain("Unused import");
    expect(text).toContain("Never");
  });

  it("renames a workspace API key inline", async () => {
    const key = {
      id: "api-key-1",
      workspaceId: "workspace-1",
      createdById: "user-1",
      createdByName: "Owner User",
      createdByEmail: "owner@example.com",
      name: "Old sync name",
      keyPrefix: "kanera_live_abc123",
      scope: "write" as const,
      lastUsedAt: null,
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
    };
    const { api } = await render({ apiKeys: [key] });
    api.patch.mockResolvedValueOnce({ ...key, name: "New sync name" });
    fixture.componentInstance.selectedTab.set("api");
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    root.querySelector<HTMLButtonElement>('[aria-label="Rename key"]')?.click();
    fixture.detectChanges();
    const input = root.querySelector<HTMLInputElement>('[aria-label="API key name"]');
    expect(input).not.toBeNull();
    if (!input) return;
    input.value = "New sync name";
    input.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>('[aria-label="Save key name"]')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.patch).toHaveBeenCalledWith("/workspaces/workspace-1/api-keys/api-key-1", { name: "New sync name" });
    expect(root.textContent).toContain("New sync name");
    expect(root.querySelector('[aria-label="API key name"]')).toBeNull();
  });

  it("shows last successful delivery status for each webhook", async () => {
    const lastSuccessfulAt = "2026-07-06T15:20:00.000Z";
    await render({
      webhooks: [
        {
          id: "webhook-1",
          workspaceId: "workspace-1",
          name: "CRM sync",
          url: "https://example.com/kanera",
          eventTypes: ["card:created"],
          enabled: true,
          lastSuccessfulAt,
          createdAt: new Date("2026-05-21T00:00:00.000Z"),
          updatedAt: new Date("2026-05-21T00:00:00.000Z"),
        },
        {
          id: "webhook-2",
          workspaceId: "workspace-1",
          name: "Audit mirror",
          url: "https://audit.example.com/kanera",
          eventTypes: [],
          enabled: false,
          lastSuccessfulAt: null,
          createdAt: new Date("2026-05-22T00:00:00.000Z"),
          updatedAt: new Date("2026-05-22T00:00:00.000Z"),
        },
      ],
    });
    fixture.componentInstance.selectedTab.set("api");
    fixture.detectChanges();

    const formattedLastSuccessful = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(lastSuccessfulAt));
    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("CRM sync");
    expect(text).toContain("Last success");
    expect(text).toContain(formattedLastSuccessful);
    expect(text).toContain("Audit mirror");
    expect(text).toContain("Never");
  });

  it("explains the enabled automation limit on capped plans", async () => {
    await render({ maxEnabledAutomations: 1 });
    activeSettingsRoute = "automations";
    (fixture.componentInstance as unknown as { updateRouteTab: () => void }).updateRouteTab();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("Your plan allows 1 enabled automation at a time");
    expect(text).toContain("Upgrade your plan to unlock this.");
  });

  it("allows a just-disabled automation to be enabled again when the enabled limit has headroom", async () => {
    const { api } = await render({ maxEnabledAutomations: 1 });
    const component = fixture.componentInstance;
    const enabled = automation({ id: "automation-1", enabled: true });
    const disabledA = automation({ id: "automation-2", enabled: false, position: "2000.0000000000" });
    const disabledB = automation({ id: "automation-3", enabled: false, position: "3000.0000000000" });
    component.automations.set([enabled, disabledA, disabledB]);

    api.patch.mockResolvedValueOnce({ ...enabled, enabled: false });
    await component.toggleAutomationEnabled(enabled);

    const justDisabled = component.automations().find((item) => item.id === enabled.id)!;
    expect(justDisabled.enabled).toBe(false);
    expect(component.canToggleAutomationEnabled(justDisabled)).toBe(true);
    expect(component.canToggleAutomationEnabled(disabledA)).toBe(true);
    expect(component.canToggleAutomationEnabled(disabledB)).toBe(true);
  });

  it("surfaces a buy-more-seats error without retrying when the seat pool is full", async () => {
    const { api, confirm } = await render();
    const component = fixture.componentInstance;
    component.guestBoards.set([{
      id: "board-2",
      name: "Client Delivery",
      icon: null,
      iconColor: null,
      position: "2000.0000000000",
    }]);
    component.guestBoardId.set("board-2");
    component.guestEmail.set("guest@example.com");
    component.guestRole.set("editor");
    api.post.mockRejectedValueOnce(new ApiError(402, { code: "SEAT_LIMIT_REACHED", message: "All purchased seats are in use." }));

    await component.inviteGuest(new Event("submit"));

    // Block-until-buy: no confirm dialog, no retry — the admin is told to buy more seats first.
    expect(confirm.open).not.toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenNthCalledWith(1, "/workspaces/workspace-1/guests/seat-preview", {
      boardId: "board-2",
      email: "guest@example.com",
      role: "editor",
      assignedItemsOnly: false,
    });
    expect(component.guestError()).toContain("Buy more seats");
  });

  it("labels the guest form as board access rather than a generic invite", async () => {
    await render();
    const component = fixture.componentInstance;
    component.selectedTab.set("guests");
    component.guestBoards.set([{ id: "board-1", name: "Roadmap", icon: null, iconColor: null, position: "1000.0000000000" }]);
    component.guestBoardId.set("board-1");

    fixture.detectChanges();
    await flushAsyncEffects();

    const button = fixture.nativeElement.querySelector(".guest-form button[type='submit']") as HTMLButtonElement | null;
    const note = fixture.nativeElement.querySelector(".guest-info-note") as HTMLElement | null;
    expect(button?.textContent).toContain("Add guest access");
    expect(note?.textContent).toContain("Add an existing guest to another board");
  });

  it("only treats a bundled pending invite as duplicate for boards already in that invite", async () => {
    await render();
    const component = fixture.componentInstance;
    component.pendingGuestInvites.set([{
      id: "invite-1",
      boardId: "board-1",
      boardName: "Roadmap",
      email: "guest@example.com",
      role: "editor",
      assignedItemsOnly: false,
      expiresAt: null,
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      boards: [
        { boardId: "board-1", boardName: "Roadmap", role: "editor" },
        { boardId: "board-2", boardName: "Delivery", role: "observer" },
      ],
    }]);
    component.guestEmail.set("GUEST@example.com");

    component.guestBoardId.set("board-2");
    expect(component.duplicatePendingGuestInvite()).toBe(true);

    component.guestBoardId.set("board-3");
    expect(component.duplicatePendingGuestInvite()).toBe(false);
  });

  it("merges another board into an existing pending guest invite row", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    component.guestBoards.set([{ id: "board-2", name: "Delivery", icon: null, iconColor: null, position: "2000.0000000000" }]);
    component.guestBoardId.set("board-2");
    component.guestEmail.set("guest@example.com");
    component.pendingGuestInvites.set([{
      id: "invite-1",
      boardId: "board-1",
      boardName: "Roadmap",
      email: "guest@example.com",
      role: "editor",
      expiresAt: null,
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      url: "https://app.test/board-invite?token=old",
      boards: [{ boardId: "board-1", boardName: "Roadmap", role: "editor" }],
    }]);
    api.post.mockResolvedValueOnce({ paidGuestSeatRequired: false, paidGuestSeatActive: false });
    api.post.mockResolvedValueOnce({
      status: "invited",
      invite: {
        id: "invite-1",
        boardId: "board-2",
        boardName: "Delivery",
        email: "guest@example.com",
        role: "observer",
        expiresAt: null,
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        boards: [{ boardId: "board-2", boardName: "Delivery", role: "observer" }],
      },
    });

    await component.inviteGuest(new Event("submit"));

    expect(component.pendingGuestInvites()).toHaveLength(1);
    expect(component.pendingGuestInvites()[0]?.url).toBe("https://app.test/board-invite?token=old");
    expect(component.pendingGuestInvites()[0]?.boards?.map((board) => board.boardId).sort()).toEqual(["board-1", "board-2"]);
  });

  it("updates existing guest rows when a paid external seat is added or removed", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    component.guestBoards.set([{ id: "board-3", name: "Launch", icon: null, iconColor: null, position: "3000.0000000000" }]);
    component.guestBoardId.set("board-3");
    component.guestEmail.set("guest@example.com");
    component.acceptedGuests.set([
      {
        boardId: "board-1",
        boardName: "Roadmap",
        userId: "guest-1",
        role: "editor",
        addedAt: new Date("2026-05-21T00:00:00.000Z"),
        email: "guest@example.com",
        displayName: "Guest User",
        avatarUrl: null,
        clientId: "external-client",
        paidGuestSeat: false,
      },
      {
        boardId: "board-2",
        boardName: "Delivery",
        userId: "guest-1",
        role: "editor",
        addedAt: new Date("2026-05-21T00:00:00.000Z"),
        email: "guest@example.com",
        displayName: "Guest User",
        avatarUrl: null,
        clientId: "external-client",
        paidGuestSeat: false,
      },
    ]);
    api.post.mockResolvedValueOnce({ paidGuestSeatRequired: true, paidGuestSeatActive: false });
    api.post.mockResolvedValueOnce({
      status: "added",
      guest: {
        boardId: "board-3",
        boardName: "Launch",
        userId: "guest-1",
        role: "editor",
        addedAt: new Date("2026-05-21T00:00:00.000Z"),
        email: "guest@example.com",
        displayName: "Guest User",
        avatarUrl: null,
        clientId: "external-client",
        paidGuestSeat: true,
      },
    });

    await component.inviteGuest(new Event("submit"));

    expect(component.acceptedGuests().filter((guest) => guest.userId === "guest-1").every((guest) => guest.paidGuestSeat)).toBe(true);

    api.delete.mockResolvedValueOnce({ paidGuestSeatRemoved: true });
    await component.removeGuest("board-3", "guest-1");

    expect(component.acceptedGuests().map((guest) => guest.boardId).sort()).toEqual(["board-1", "board-2"]);
    expect(component.acceptedGuests().filter((guest) => guest.userId === "guest-1").every((guest) => guest.paidGuestSeat === false)).toBe(true);
  });

  it("explains paid guest seat allocation before adding the guest", async () => {
    const { api, confirm } = await render({ confirmResult: false });
    const component = fixture.componentInstance;
    component.guestBoards.set([{ id: "board-3", name: "Launch", icon: null, iconColor: null, position: "3000.0000000000" }]);
    component.guestBoardId.set("board-3");
    component.guestEmail.set("guest@example.com");
    component.guestRole.set("editor");
    api.post.mockResolvedValueOnce({ paidGuestSeatRequired: true, paidGuestSeatActive: false });

    await component.inviteGuest(new Event("submit"));

    expect(confirm.open).toHaveBeenCalledWith({
      title: "This guest will use a paid seat",
      message: expect.stringContaining("Kanera will assign one of your purchased seats"),
      confirmLabel: "Use seat",
      danger: false,
    });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith("/workspaces/workspace-1/guests/seat-preview", {
      boardId: "board-3",
      email: "guest@example.com",
      role: "editor",
      assignedItemsOnly: false,
    });
    expect(component.acceptedGuests()).toEqual([]);
  });

  it("shows an error instead of resetting when the email already has board access", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    component.guestBoards.set([{ id: "board-3", name: "Launch", icon: null, iconColor: null, position: "3000.0000000000" }]);
    component.guestBoardId.set("board-3");
    component.guestEmail.set("member@example.com");
    component.guestRole.set("editor");
    api.post.mockRejectedValueOnce(new ApiError(409, { message: "This person already has access to this board." }));

    await component.inviteGuest(new Event("submit"));

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith("/workspaces/workspace-1/guests/seat-preview", {
      boardId: "board-3",
      email: "member@example.com",
      role: "editor",
      assignedItemsOnly: false,
    });
    expect(component.guestError()).toBe("This person already has access to this board.");
    expect(component.guestEmail()).toBe("member@example.com");
  });

  it("shows paid external guest seats in the guest identity cell", async () => {
    await render();
    const component = fixture.componentInstance;
    component.selectedTab.set("guests");
    component.acceptedGuests.set([{
      boardId: "board-1",
      boardName: "Roadmap",
      userId: "guest-1",
      role: "editor",
      addedAt: new Date("2026-05-21T00:00:00.000Z"),
      email: "guest@example.com",
      displayName: "Guest User",
      avatarUrl: null,
      clientId: "external-client",
      paidGuestSeat: true,
    }]);

    fixture.detectChanges();
    await flushAsyncEffects();

    const identity = fixture.nativeElement.querySelector(".guest-row .org-user-identity") as HTMLElement | null;
    expect(identity?.textContent).toContain("Guest User");
    expect(identity?.textContent).toContain("Paid seat");
  });

  it("lets admins change accepted guest card access from the guests tab", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    component.selectedTab.set("guests");
    component.acceptedGuests.set([{
      boardId: "board-1",
      boardName: "Roadmap",
      userId: "guest-1",
      role: "observer",
      assignedItemsOnly: true,
      addedAt: new Date("2026-05-21T00:00:00.000Z"),
      email: "guest@example.com",
      displayName: "Guest User",
      avatarUrl: null,
      clientId: "external-client",
    }]);
    api.patch.mockResolvedValueOnce({});

    fixture.detectChanges();
    await flushAsyncEffects();

    const accessSelect = fixture.nativeElement.querySelector(".guest-access-select") as HTMLSelectElement | null;
    expect(accessSelect?.value).toBe("assigned");
    accessSelect!.value = "all";
    accessSelect!.dispatchEvent(new Event("input"));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(api.patch).toHaveBeenCalledWith("/boards/board-1/members/guest-1", {
      role: "observer",
      assignedItemsOnly: false,
    });
    expect(component.acceptedGuests()[0]?.assignedItemsOnly).toBe(false);
  });

  it("keeps unfinished automation actions as unsaved drafts", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    const automation = {
      id: "automation-1",
      workspaceId: "workspace-1",
      enabled: true,
      position: "1000.0000000000",
      triggerType: "card_enters_list",
      triggerListId: "list-1",
      triggerUserIds: null,
      triggerLabelId: null,
      applyOnCreate: true,
      applyOnMove: true,
      archivedAt: null,
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      actions: [{
        id: "action-1",
        automationId: "automation-1",
        type: "set_completion",
        config: { completed: true },
        position: "1000.0000000000",
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      }],
    } satisfies WireAutomation;
    component.automations.set([automation]);
    component.toggleAutomationExpanded("automation-1");

    component.updateAutomationActionType("automation-1", 0, "add_labels");
    await flushAsyncEffects();

    expect(api.put).toHaveBeenCalledWith("/automations/automation-1/actions", { actions: [] });
    const draft = component.automationDraftActions("automation-1")[0];
    expect(draft).toEqual({ type: "add_labels", config: { labelIds: [] } });
    expect(component.automationActionSummary(draft!)).toBe("Add label (choose label)");

    (component as unknown as { replaceAutomation: (automation: WireAutomation) => void }).replaceAutomation({
      ...automation,
      actions: [],
    });

    expect(component.automationDraftActions("automation-1")[0]).toEqual({ type: "add_labels", config: { labelIds: [] } });
  });

  it("keeps unfinished checklist automation actions as unsaved drafts", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    const automation = {
      id: "automation-1",
      workspaceId: "workspace-1",
      enabled: true,
      position: "1000.0000000000",
      triggerType: "card_enters_list",
      triggerListId: "list-1",
      triggerUserIds: null,
      triggerLabelId: null,
      applyOnCreate: true,
      applyOnMove: true,
      archivedAt: null,
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      actions: [{
        id: "action-1",
        automationId: "automation-1",
        type: "set_completion",
        config: { completed: true },
        position: "1000.0000000000",
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      }],
    } satisfies WireAutomation;
    component.automations.set([automation]);
    component.toggleAutomationExpanded("automation-1");

    component.updateAutomationActionType("automation-1", 0, "apply_checklists");
    await flushAsyncEffects();

    expect(api.put).toHaveBeenCalledWith("/automations/automation-1/actions", { actions: [] });
    const draft = component.automationDraftActions("automation-1")[0];
    expect(draft).toEqual({ type: "apply_checklists", config: { templateIds: [] } });
    expect(component.automationActionSummary(draft!)).toBe("Apply checklist (choose checklists)");
  });

  it("summarizes set custom field automation actions", async () => {
    await render();
    const component = fixture.componentInstance;
    component.fields.set([customField()]);

    const action = { type: "populate_custom_field", config: { fieldId: "field-1", onlyIfEmpty: true, value: { kind: "text_current_date", format: "month" } } } satisfies AutomationActionBody;
    const shortYearAction = { type: "populate_custom_field", config: { fieldId: "field-1", onlyIfEmpty: true, value: { kind: "text_current_date", format: "month_long_short_year" } } } satisfies AutomationActionBody;
    const longYearAction = { type: "populate_custom_field", config: { fieldId: "field-1", onlyIfEmpty: true, value: { kind: "text_current_date", format: "month_long_year" } } } satisfies AutomationActionBody;
    const textAction = { type: "populate_custom_field", config: { fieldId: "field-1", onlyIfEmpty: true, value: { kind: "text", text: "Ready to bill" } } } satisfies AutomationActionBody;

    expect(component.automationActionVerbLabel(action)).toBe("Set custom field");
    expect(component.automationActionTargetLabel(action)).toBe("Billing Month · YYYY-MM");
    expect(component.automationActionSummary(action)).toBe("Set Billing Month to YYYY-MM");
    expect(component.automationActionTargetLabel(shortYearAction)).toBe("Billing Month · MMMM yy");
    expect(component.automationActionTargetLabel(longYearAction)).toBe("Billing Month · MMMM yyyy");
    expect(component.automationActionIcon(action)).toBe("ti-forms");
    expect(component.automationActionTargetLabel(textAction)).toBe("Billing Month · Ready to bill");
  });

  it("uses friendly due date labels in automation summaries", async () => {
    await render();
    const component = fixture.componentInstance;
    const anyTimeAction = { type: "set_due_date", config: { offsetDays: 0, slot: "anyTime" } } satisfies AutomationActionBody;
    const endOfWorkDayAction = { type: "set_due_date", config: { offsetDays: 1, slot: "endOfWorkDay" } } satisfies AutomationActionBody;
    const weekAction = { type: "set_due_date", config: { offsetDays: 7, slot: "morning" } } satisfies AutomationActionBody;
    const pastAction = { type: "set_due_date", config: { offsetDays: -3, slot: "afternoon" } } satisfies AutomationActionBody;

    expect(component.automationActionTargetLabel(anyTimeAction)).toBe("today");
    expect(component.automationActionSummary(anyTimeAction)).toBe("Set due date today");
    expect(component.automationActionTargetLabel(endOfWorkDayAction)).toBe("tomorrow, End of workday");
    expect(component.automationActionSummary(weekAction)).toBe("Set due date in 1 week, Morning");
    expect(component.automationActionTargetLabel(pastAction)).toBe("3 days ago, Afternoon");
  });

  it("updates due date presets while preserving the selected slot", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    component.automations.set([automation()]);
    component.automationActionDrafts.set({
      "automation-1": [{ type: "set_due_date", config: { offsetDays: 0, slot: "endOfWorkDay" } }],
    });

    component.updateAutomationDueDatePreset("automation-1", 0, "7");
    await flushAsyncEffects();

    const draft = component.automationDraftActions("automation-1")[0];
    expect(draft).toEqual({ type: "set_due_date", config: { offsetDays: 7, slot: "endOfWorkDay" } });
    expect(api.put).toHaveBeenLastCalledWith("/automations/automation-1/actions", { actions: [{ type: "set_due_date", config: { offsetDays: 7, slot: "endOfWorkDay" } }] });
  });

  it("shows custom due date input when custom is selected from a preset", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    const action = { type: "set_due_date", config: { offsetDays: 0, slot: "anyTime" } } satisfies AutomationActionBody;
    component.automations.set([automation()]);
    component.automationActionDrafts.set({ "automation-1": [action] });
    api.put.mockClear();

    expect(component.automationDueDatePresetValue(action, "automation-1", 0)).toBe("0");

    component.updateAutomationDueDatePreset("automation-1", 0, "custom");
    await flushAsyncEffects();

    expect(component.automationDueDatePresetValue(action, "automation-1", 0)).toBe("custom");
    expect(component.isAutomationDueDateCustom(action, "automation-1", 0)).toBe(true);
    expect(api.put).not.toHaveBeenCalled();
  });

  it("keeps custom due date offsets editable without losing data", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    const action = { type: "set_due_date", config: { offsetDays: 5, slot: "morning" } } satisfies AutomationActionBody;

    expect(component.automationDueDatePresetValue(action)).toBe("custom");
    expect(component.isAutomationDueDateCustom(action)).toBe(true);

    component.automations.set([automation()]);
    component.automationActionDrafts.set({ "automation-1": [action] });
    component.updateAutomationDueOffset("automation-1", 0, 6);
    await flushAsyncEffects();

    expect(component.automationDraftActions("automation-1")[0]).toEqual({ type: "set_due_date", config: { offsetDays: 6, slot: "morning" } });
    expect(api.put).toHaveBeenLastCalledWith("/automations/automation-1/actions", { actions: [{ type: "set_due_date", config: { offsetDays: 6, slot: "morning" } }] });
  });

  it("defaults set custom field actions to unsaved text drafts", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    component.fields.set([customField()]);
    component.automations.set([automation()]);
    component.toggleAutomationExpanded("automation-1");

    component.updateAutomationActionType("automation-1", 0, "populate_custom_field");
    await flushAsyncEffects();

    const draft = component.automationDraftActions("automation-1")[0];
    expect(api.put).toHaveBeenLastCalledWith("/automations/automation-1/actions", { actions: [] });
    expect(draft).toEqual({ type: "populate_custom_field", config: { fieldId: "field-1", onlyIfEmpty: true, value: { kind: "text", text: "" } } });
  });

  it("does not add more than five automation action drafts", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    component.automations.set([automation({ actions: automationActions(AUTOMATION_ACTION_LIMIT) })]);
    component.toggleAutomationExpanded("automation-1");
    api.put.mockClear();

    component.addAutomationAction("automation-1");
    await flushAsyncEffects();

    expect(component.automationDraftActions("automation-1")).toHaveLength(AUTOMATION_ACTION_LIMIT);
    expect(api.put).not.toHaveBeenCalled();
  });

  it("disables the add action button at the automation action limit", async () => {
    await render();
    const component = fixture.componentInstance;
    component.selectedTab.set("automations");
    component.automations.set([automation({ actions: automationActions(AUTOMATION_ACTION_LIMIT) })]);
    component.expandedAutomationIds.set(new Set(["automation-1"]));
    fixture.detectChanges();
    await fixture.whenStable();

    const addButton = fixture.nativeElement.querySelector(".automation-add-action") as HTMLButtonElement | null;
    expect(addButton).not.toBeNull();
    expect(addButton?.disabled).toBe(true);
    expect(addButton?.textContent).toContain("5 actions maximum");
  });

  it("does not create more than thirty automations", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    component.lists.set([workspaceList()]);
    component.automations.set(automations(AUTOMATION_LIMIT));
    api.post.mockClear();

    await component.addAutomation(new Event("submit"));

    expect(api.post).not.toHaveBeenCalled();
  });

  it("disables the add automation button at the workspace automation limit", async () => {
    await render();
    const component = fixture.componentInstance;
    component.selectedTab.set("automations");
    component.lists.set([workspaceList()]);
    component.automations.set(automations(AUTOMATION_LIMIT));
    fixture.detectChanges();
    await fixture.whenStable();

    const addButton = fixture.nativeElement.querySelector(".board-form .compact-add-button") as HTMLButtonElement | null;
    expect(addButton).not.toBeNull();
    expect(addButton?.disabled).toBe(true);
    expect(fixture.nativeElement.textContent).toContain("Workspaces can have up to 30 automations. Contact support if you need more.");
  });

  it("keeps populate text actions unsaved until text is provided", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    component.fields.set([customField()]);
    component.automations.set([automation()]);
    component.toggleAutomationExpanded("automation-1");

    component.updateAutomationActionType("automation-1", 0, "populate_custom_field");
    await flushAsyncEffects();

    expect(component.automationDraftActions("automation-1")[0]).toEqual({ type: "populate_custom_field", config: { fieldId: "field-1", onlyIfEmpty: true, value: { kind: "text", text: "" } } });
    expect(api.put).toHaveBeenLastCalledWith("/automations/automation-1/actions", { actions: [] });

    component.updateAutomationPopulateText("automation-1", 0, "Ready to bill");
    await flushAsyncEffects();

    expect(api.put).toHaveBeenLastCalledWith("/automations/automation-1/actions", {
      actions: [{ type: "populate_custom_field", config: { fieldId: "field-1", onlyIfEmpty: true, value: { kind: "text", text: "Ready to bill" } } }],
    });
  });

  it("serializes typed set custom field values and overwrite policy", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    component.fields.set([
      customField(),
      customField({ id: "field-date", name: "Billing Date", type: "date" }),
      customField({ id: "field-checkbox", name: "Billable", type: "checkbox" }),
      customField({
        id: "field-select",
        name: "Status",
        type: "select",
        options: [{ id: "option-done", fieldId: "field-select", label: "Done", color: null, position: "1000.0000000000", archivedAt: null, createdAt: new Date("2026-05-21T00:00:00.000Z"), updatedAt: new Date("2026-05-21T00:00:00.000Z") }],
      }),
      customField({ id: "field-user", name: "Reviewer", type: "user" }),
    ]);
    component.members.set([member()]);
    component.automations.set([automation()]);
    component.toggleAutomationExpanded("automation-1");

    component.updateAutomationActionType("automation-1", 0, "populate_custom_field");
    await flushAsyncEffects();
    component.updateAutomationActionTarget("automation-1", 0, "field-date");
    await flushAsyncEffects();
    expect(api.put).toHaveBeenLastCalledWith("/automations/automation-1/actions", {
      actions: [{ type: "populate_custom_field", config: { fieldId: "field-date", onlyIfEmpty: true, value: { kind: "date", source: "current" } } }],
    });

    component.updateAutomationPopulatePolicy("automation-1", 0, "overwrite");
    component.updateAutomationPopulateDateSource("automation-1", 0, "fixed");
    await flushAsyncEffects();
    expect(api.put).toHaveBeenLastCalledWith("/automations/automation-1/actions", { actions: [] });
    component.updateAutomationPopulateDate("automation-1", 0, "2026-06-01");
    await flushAsyncEffects();
    expect(api.put).toHaveBeenLastCalledWith("/automations/automation-1/actions", {
      actions: [{ type: "populate_custom_field", config: { fieldId: "field-date", onlyIfEmpty: false, value: { kind: "date", source: "fixed", date: "2026-06-01" } } }],
    });

    component.updateAutomationActionTarget("automation-1", 0, "field-checkbox");
    component.updateAutomationPopulateCheckbox("automation-1", 0, false);
    await flushAsyncEffects();
    expect(api.put).toHaveBeenLastCalledWith("/automations/automation-1/actions", {
      actions: [{ type: "populate_custom_field", config: { fieldId: "field-checkbox", onlyIfEmpty: false, value: { kind: "checkbox", checked: false } } }],
    });

    component.updateAutomationActionTarget("automation-1", 0, "field-select");
    await flushAsyncEffects();
    expect(api.put).toHaveBeenLastCalledWith("/automations/automation-1/actions", {
      actions: [{ type: "populate_custom_field", config: { fieldId: "field-select", onlyIfEmpty: false, value: { kind: "select", optionIds: ["option-done"] } } }],
    });

    component.updateAutomationActionTarget("automation-1", 0, "field-user");
    await flushAsyncEffects();
    expect(api.put).toHaveBeenLastCalledWith("/automations/automation-1/actions", {
      actions: [{ type: "populate_custom_field", config: { fieldId: "field-user", onlyIfEmpty: false, value: { kind: "user", userIds: ["user-1"] } } }],
    });
  });

  it("summarizes checklist automation action template targets", async () => {
    await render();
    const component = fixture.componentInstance;
    component.templates.set([
      {
        id: "template-1",
        workspaceId: "workspace-1",
        title: "Definition of Done",
        position: "1000.0000000000",
        archivedAt: null,
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z"),
        items: [],
      },
      {
        id: "template-2",
        workspaceId: "workspace-1",
        title: "Release",
        position: "2000.0000000000",
        archivedAt: null,
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z"),
        items: [],
      },
      {
        id: "template-3",
        workspaceId: "workspace-1",
        title: "Security",
        position: "3000.0000000000",
        archivedAt: null,
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z"),
        items: [],
      },
    ]);

    const action = { type: "apply_checklists", config: { templateIds: ["template-1", "template-2", "template-3"] } } satisfies AutomationActionBody;
    expect(component.automationActionVerbLabel(action)).toBe("Apply checklist");
    expect(component.automationActionTargetLabel(action)).toBe("Definition of Done, Release +1");
    expect(component.automationActionIcon(action)).toBe("ti-list-check");
  });

  it("uses checklist automation drafts in collapsed action summaries", async () => {
    await render();
    const component = fixture.componentInstance;
    component.templates.set([
      {
        id: "template-1",
        workspaceId: "workspace-1",
        title: "Definition of Done",
        position: "1000.0000000000",
        archivedAt: null,
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z"),
        items: [],
      },
    ]);
    const automation = {
      id: "automation-1",
      workspaceId: "workspace-1",
      enabled: true,
      position: "1000.0000000000",
      triggerType: "card_enters_list",
      triggerListId: "list-1",
      triggerUserIds: null,
      triggerLabelId: null,
      applyOnCreate: true,
      applyOnMove: true,
      archivedAt: null,
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      actions: [],
    } satisfies WireAutomation;
    component.automations.set([automation]);
    component.automationActionDrafts.set({
      "automation-1": [{ type: "apply_checklists", config: { templateIds: ["template-1"] } }],
    });

    const [summary] = component.automationSummaryActions(automation);
    expect(summary).toEqual({ type: "apply_checklists", config: { templateIds: ["template-1"] } });
    expect(component.automationActionTargetLabel(summary!)).toBe("Definition of Done");
  });

  it("summarizes created and moved automation triggers on collapsed cards", async () => {
    await render();
    const component = fixture.componentInstance;
    const automation = {
      id: "automation-1",
      workspaceId: "workspace-1",
      enabled: true,
      position: "1000.0000000000",
      triggerType: "card_enters_list",
      triggerListId: "list-1",
      triggerUserIds: null,
      triggerLabelId: null,
      applyOnCreate: true,
      applyOnMove: true,
      archivedAt: null,
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      actions: [],
    } satisfies WireAutomation;

    expect(component.automationTriggerEventLabel(automation)).toBe("Card created or moved into");
    expect(component.automationTriggerEventLabel({ ...automation, applyOnMove: false })).toBe("Card created in");
    expect(component.automationTriggerEventLabel({ ...automation, applyOnCreate: false })).toBe("Card moved into");
  });

  it("summarizes and updates card-assigned trigger users", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    component.members.set([
      member({ userId: "user-1", displayName: "Alice", role: "member" as const }),
      member({ userId: "user-2", displayName: "Ben", role: "member" as const }),
    ]);
    const automation = {
      id: "automation-1",
      workspaceId: "workspace-1",
      enabled: true,
      position: "1000.0000000000",
      triggerType: "card_assigned_to_user",
      triggerListId: null,
      triggerUserIds: ["user-1", "user-2"],
      triggerLabelId: null,
      applyOnCreate: true,
      applyOnMove: true,
      archivedAt: null,
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      actions: [],
    } satisfies WireAutomation;
    component.automations.set([automation]);

    expect(component.automationTriggerTypeValue(automation)).toBe("card_assigned_to_user");
    expect(component.automationTriggerEventLabel(automation)).toBe("Card assigned to");
    expect(component.automationTriggerTargetLabel(automation)).toBe("Alice, Ben");

    api.patch.mockResolvedValue({ ...automation, triggerUserIds: ["user-1"] });
    await component.toggleAutomationTriggerUser("automation-1", "user-2");

    expect(api.patch).toHaveBeenCalledWith("/automations/automation-1", { triggerUserIds: ["user-1"] });
  });

  it("summarizes and updates card-marked-complete automations without trigger targets", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    const current = automation();
    const updated = automation({
      triggerType: "card_marked_complete",
      triggerListId: null,
      triggerUserIds: null,
      triggerLabelId: null,
    });
    component.automations.set([current]);

    expect(component.automationTriggerTypeValue(updated)).toBe("card_marked_complete");
    expect(component.automationTriggerLabel(updated)).toBe("Card marked complete");
    expect(component.automationTriggerEventLabel(updated)).toBe("Card marked complete");
    expect(component.automationTriggerTargetLabel(updated)).toBeNull();

    api.patch.mockResolvedValue(updated);
    await component.updateAutomationTrigger(current.id, "card_marked_complete");

    expect(api.patch).toHaveBeenCalledWith(`/automations/${current.id}`, {
      triggerType: "card_marked_complete",
      triggerListId: null,
      triggerUserIds: null,
      triggerLabelId: null,
    });
    expect(component.automations()[0]?.triggerType).toBe("card_marked_complete");
  });

  it("summarizes label-set automations and shows deleted labels", async () => {
    await render();
    const component = fixture.componentInstance;
    component.labels.set([cardLabel({ id: "label-1", name: "Urgent" })]);
    const labelAutomation = automation({
      triggerType: "card_label_set",
      triggerListId: null,
      triggerUserIds: null,
      triggerLabelId: "label-1",
    });

    expect(component.automationTriggerTypeValue(labelAutomation)).toBe("card_label_set");
    expect(component.automationTriggerEventLabel(labelAutomation)).toBe("Label set");
    expect(component.automationTriggerTargetLabel(labelAutomation)).toBe("Urgent");
    expect(component.automationTriggerLabelMissing(labelAutomation)).toBe(false);

    component.labels.set([]);
    expect(component.automationTriggerTargetLabel(labelAutomation)).toBe("Deleted label");
    expect(component.automationTriggerLabelMissing(labelAutomation)).toBe(true);
  });

  it("orders workspace members and guests alphabetically", async () => {
    await render();
    const component = fixture.componentInstance;
    component.members.set([
      member({ userId: "user-z", displayName: "Zoe", email: "zoe@example.com" }),
      member({ userId: "user-a", displayName: "ada", email: "ada@example.com" }),
    ]);
    component.acceptedGuests.set([
      { boardId: "board-1", boardName: "Roadmap", userId: "guest-z", role: "editor", addedAt: new Date(), email: "zoe@external.test", displayName: "Zoe", avatarUrl: null, clientId: "client-2" },
      { boardId: "board-1", boardName: "Roadmap", userId: "guest-a", role: "observer", addedAt: new Date(), email: "ada@external.test", displayName: "ada", avatarUrl: null, clientId: "client-2" },
    ]);
    component.pendingGuestInvites.set([
      { id: "invite-z", boardId: "board-1", boardName: "Roadmap", email: "zoe@pending.test", role: "editor", expiresAt: null, createdAt: new Date() },
      { id: "invite-a", boardId: "board-1", boardName: "Roadmap", email: "ada@pending.test", role: "observer", expiresAt: null, createdAt: new Date() },
    ]);
    component.orgUsers.set([
      { id: "org-z", displayName: "Zoe", email: "zoe@org.test" },
      { id: "org-a", displayName: "ada", email: "ada@org.test" },
      { id: "user-a", displayName: "Already added", email: "member@org.test" },
    ]);

    expect(component.filteredMembers().map((row) => row.displayName)).toEqual(["ada", "Zoe"]);
    expect(component.availableOrgUsers().map((row) => row.displayName)).toEqual(["ada", "Zoe"]);
    expect(component.sortedAcceptedGuests().map((row) => row.displayName)).toEqual(["ada", "Zoe"]);
    expect(component.sortedPendingGuestInvites().map((row) => row.email)).toEqual(["ada@pending.test", "zoe@pending.test"]);
  });

  it("treats organisation owners and admins as fixed workspace admins", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    const inheritedAdmin = member({ userId: "org-admin", role: "admin", orgRole: "admin" });
    component.members.set([inheritedAdmin]);
    api.patch.mockClear();
    api.delete.mockClear();

    expect(component.isInheritedWorkspaceAdmin(inheritedAdmin)).toBe(true);
    await component.updateMemberRole(inheritedAdmin.userId, "member");
    await component.removeMember(inheritedAdmin.userId);

    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("navigates out when the current user loses workspace admin access", async () => {
    const { api, socket, router } = await render();
    api.get.mockResolvedValueOnce([member({ role: "member", orgRole: "member" })]);

    socket.trigger("workspace:member:updated", {
      workspaceId: "workspace-1",
      member: { workspaceId: "workspace-1", userId: "user-1", role: "member", addedAt: new Date() },
    });

    await vi.waitFor(() => expect(router.navigate).toHaveBeenCalledWith(["/"]));
  });

  it("updates label-set automations with a trigger label target", async () => {
    const { api } = await render();
    const component = fixture.componentInstance;
    component.labels.set([cardLabel({ id: "label-1", name: "Urgent" })]);
    const current = automation();
    const updated = automation({
      triggerType: "card_label_set",
      triggerListId: null,
      triggerUserIds: null,
      triggerLabelId: "label-1",
    });
    component.automations.set([current]);

    api.patch.mockResolvedValue(updated);
    await component.updateAutomationTrigger(current.id, "card_label_set");

    expect(api.patch).toHaveBeenCalledWith(`/automations/${current.id}`, {
      triggerType: "card_label_set",
      triggerListId: null,
      triggerUserIds: null,
      triggerLabelId: "label-1",
    });
    expect(component.automations()[0]?.triggerType).toBe("card_label_set");
  });
});
