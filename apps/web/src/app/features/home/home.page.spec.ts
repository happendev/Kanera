import { provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { provideRouter, Router } from "@angular/router";
import type { HomeItem, HomeTodayResponse } from "@kanera/shared/dto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { organisationStorageKey, STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import type { AppSocket } from "../../core/realtime/socket.service";
import { SocketService } from "../../core/realtime/socket.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { HomePage } from "./home.page";

class SocketStub {
  readonly handlers = new Map<string, (...args: unknown[]) => void>();
  readonly on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    this.handlers.set(event, handler);
    return this;
  });
  readonly off = vi.fn(() => this);

  asSocket(): AppSocket {
    return this as unknown as AppSocket;
  }
}

function item(overrides: Partial<HomeItem> = {}): HomeItem {
  return {
    kind: "card",
    id: "card-1",
    cardId: "card-1",
    cardKey: "WORK-1",
    title: "Ship the thing",
    cardTitle: null,
    bucket: "today",
    boardId: "board-1",
    boardName: "Roadmap",
    boardIcon: null,
    boardIconColor: null,
    workspaceId: "workspace-1",
    workspaceName: "Delivery",
    guestOrganisationName: null,
    listId: "list-1",
    listName: "Doing",
    labels: [],
    dueDateLocalDate: "2026-07-26",
    dueDateSlot: "anyTime",
    dueDateTimezone: "UTC",
    ...overrides,
    organisationKey: overrides.organisationKey ?? "0123456789ABCDEF",
  };
}

function payload(overrides: Partial<HomeTodayResponse> = {}): HomeTodayResponse {
  return {
    timeZone: "UTC",
    today: "2026-07-26",
    horizonEnd: "2026-08-02",
    counts: {
      overdueCards: 1,
      overdueChecklistItems: 0,
      dueTodayCards: 1,
      dueTodayChecklistItems: 0,
      dueTomorrowCards: 0,
      dueTomorrowChecklistItems: 0,
      dueLaterThisWeekCards: 1,
      dueLaterThisWeekChecklistItems: 0,
      dueWithin7DaysCards: 2,
      dueWithin7DaysChecklistItems: 0,
      assignedCards: 5,
      assignedChecklistItems: 0,
    },
    items: [
      item({ id: "card-overdue", cardId: "card-overdue", bucket: "overdue", title: "Late thing" }),
      item(),
      item({ id: "card-later", cardId: "card-later", bucket: "laterThisWeek", title: "Later thing" }),
    ],
    itemsTruncated: false,
    trend: {
      days: 28,
      byDay: [{ date: "2026-07-25", completedCards: 2 }],
      thisWeek: { completedCards: 5 },
      lastWeek: { completedCards: 3 },
    },
    boardCount: 3,
    automationExecutionsRemaining: null,
    proUsage: null,
    ...overrides,
  };
}

const BOARD_SUMMARIES: Record<string, { name: string; icon: string | null; iconColor: string | null }> = {
  "board-1": { name: "Roadmap", icon: null, iconColor: null },
  "board-2": { name: "Hiring Plan", icon: null, iconColor: null },
  "board-3": { name: "Launch", icon: null, iconColor: null },
  "board-4": { name: "Research", icon: null, iconColor: null },
  "board-5": { name: "Operations", icon: null, iconColor: null },
  "board-6": { name: "Archive", icon: null, iconColor: null },
};

describe("HomePage", () => {
  let fixture: ComponentFixture<HomePage>;

  async function render(options: {
    response?: HomeTodayResponse;
    apiFails?: boolean;
    /** Never resolves, so the loading branch stays on screen. */
    pending?: boolean;
    cached?: { key: string; cachedAt: string; response: HomeTodayResponse } | null;
    hasWorkspace?: boolean;
    /** Boards the shell has registered, which the board strip falls back to with no visit history. */
    registeredBoards?: { id: string; name: string; icon: string | null; iconColor: string | null }[];
    isOrgAdmin?: boolean;
    entitlements?: unknown;
    deploymentMode?: "hosted" | "self_hosted";
    role?: "owner" | "admin" | "member";
  } = {}) {
    const socket = new SocketStub();
    const get = vi.fn(async (path: string) => {
      if (path.startsWith("/home/today")) {
        if (options.pending) return new Promise<never>(() => undefined);
        if (options.apiFails) throw new Error("offline");
        return options.response ?? payload();
      }
      return {};
    });

    await TestBed.configureTestingModule({
      imports: [HomePage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get } },
        {
          provide: AuthService,
          useValue: {
            user: signal({
              id: "user-1",
              clientId: "client-1",
              displayName: "Me User",
              hasWorkspace: options.hasWorkspace ?? true,
              deploymentMode: options.deploymentMode ?? "hosted",
              role: options.role ?? (options.isOrgAdmin ? "admin" : "member"),
            }),
            isOrgAdmin: signal(options.isOrgAdmin ?? false),
            entitlements: signal(options.entitlements ?? null),
            maxBoards: signal((options.entitlements as { maxBoards?: number | null } | undefined)?.maxBoards ?? null),
          },
        },
        {
          provide: OfflineCacheService,
          useValue: {
            saveHomeToday: vi.fn(async () => undefined),
            loadHomeToday: vi.fn(async () => options.cached ?? null),
          },
        },
        provideRouter([]),
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(() => socket.asSocket()),
            joinBoard: vi.fn(() => vi.fn()),
            joinWorkspace: vi.fn(() => vi.fn()),
            displayedOnline: signal(true),
            reconnecting: signal(false),
            accessRefreshing: signal(false),
          },
        },
        {
          provide: WorkspaceService,
          useValue: {
            boardSummaryFor: vi.fn((id: string) => BOARD_SUMMARIES[id] ?? null),
            boards: signal(options.registeredBoards ?? []),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(HomePage);
    fixture.detectChanges();
    await settle();
    return { get, socket };
  }

  /**
   * `whenStable()` alone can resolve mid-way through HomeState's load chain (network → signal →
   * cache write), so flush a macrotask too before asserting on the rendered branch.
   */
  async function settle(): Promise<void> {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  function host(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function text(): string {
    return host().textContent ?? "";
  }

  it("renders a skeleton while loading and never an empty main", async () => {
    // Regression guard for the old failure mode: a rejected or slow request left `loaded()` false
    // and rendered literally nothing.
    await render({ pending: true });

    expect(host().querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    expect(host().querySelector("main")!.textContent!.trim()).not.toBe("");
  });

  it("renders the four focus tiles with totals and a week-over-week delta", async () => {
    await render();

    const tiles = [...host().querySelectorAll(".stat-tile")].map((tile) => tile.textContent ?? "");
    expect(tiles).toHaveLength(4);
    expect(tiles[0]).toContain("Overdue");
    expect(tiles[0]).toContain("1");
    expect(tiles[2]).toContain("Next 7 days");
    expect(tiles[2]).toContain("2");
    // Five cards completed this week against three last week.
    expect(tiles[3]).toContain("+2 vs last week");
  });

  it("shows the overdue tile in danger tone only when there is overdue work", async () => {
    await render();
    expect(host().querySelector(".stat-tile.danger")).not.toBeNull();

    TestBed.resetTestingModule();
    await render({
      response: payload({
        items: [item()],
        counts: { ...payload().counts, overdueCards: 0 },
      }),
    });
    // A zero still renders a tile — it is information — just not in danger tone.
    expect([...host().querySelectorAll(".stat-tile")]).toHaveLength(4);
    expect(host().querySelector(".stat-tile.danger")).toBeNull();
  });

  it("only makes a tile clickable when clicking it would visibly do something", async () => {
    await render();
    // Three due tiles filter the agenda; "Done this week" is a readout whose detail is the
    // progress panel below, so it must not invite a click.
    expect(host().querySelectorAll("button.stat-tile")).toHaveLength(3);
    const done = [...host().querySelectorAll(".stat-tile")].at(-1)!;
    expect(done.tagName).toBe("DIV");
    expect(done.classList.contains("is-static")).toBe(true);

    TestBed.resetTestingModule();
    await render({
      response: payload({
        items: [item()],
        counts: { ...payload().counts, overdueCards: 0, dueLaterThisWeekCards: 0, dueWithin7DaysCards: 1 },
      }),
    });
    // Nothing overdue means nothing to filter to, so that tile goes static too.
    expect(host().querySelectorAll("button.stat-tile")).toHaveLength(2);
  });

  it("filters the agenda to a bucket and toggles back off", async () => {
    await render();
    const headings = () => [...host().querySelectorAll(".agenda-group-header h3")].map((n) => n.textContent);
    expect(headings()).toEqual(["Overdue", "Today", "Later this week"]);

    const overdueTile = host().querySelector<HTMLButtonElement>("button.stat-tile")!;
    overdueTile.click();
    fixture.detectChanges();

    expect(headings()).toEqual(["Overdue"]);
    expect(host().querySelector("button.stat-tile")!.classList.contains("is-active")).toBe(true);
    expect(host().querySelector("button.stat-tile")!.getAttribute("aria-pressed")).toBe("true");
    expect(host().querySelector(".focus-clear")!.textContent).toContain("Showing overdue work");

    // Clicking the engaged tile clears it rather than dead-ending.
    host().querySelector<HTMLButtonElement>("button.stat-tile")!.click();
    fixture.detectChanges();
    expect(headings()).toEqual(["Overdue", "Today", "Later this week"]);
    expect(host().querySelector(".focus-clear")).toBeNull();
  });

  it("filters Next 7 days to every dated bucket except overdue, and the chip clears it", async () => {
    await render();
    const tiles = [...host().querySelectorAll<HTMLButtonElement>("button.stat-tile")];
    tiles[2].click();
    fixture.detectChanges();

    expect([...host().querySelectorAll(".agenda-group-header h3")].map((n) => n.textContent))
      .toEqual(["Today", "Later this week"]);

    host().querySelector<HTMLButtonElement>(".focus-clear")!.click();
    fixture.detectChanges();
    expect([...host().querySelectorAll(".agenda-group-header h3")]).toHaveLength(3);
  });

  it("explains an empty filter instead of reading as all-clear", async () => {
    // The overdue count is non-zero (so the tile is live) but no overdue rows came back — the
    // shape a realtime refresh can leave behind while a filter is engaged.
    await render({
      response: payload({
        items: [item()],
        counts: { ...payload().counts, overdueCards: 2 },
      }),
    });

    host().querySelector<HTMLButtonElement>("button.stat-tile")!.click();
    fixture.detectChanges();

    expect(text()).toContain("Nothing left in this filter");
    expect(text()).not.toContain("You're all clear");

    host().querySelector<HTMLButtonElement>(".agenda-clear button")!.click();
    fixture.detectChanges();
    expect(host().querySelectorAll(".agenda-row").length).toBeGreaterThan(0);
  });

  it("renders agenda groups in bucket order and omits empty buckets", async () => {
    await render();

    const headings = [...host().querySelectorAll(".agenda-group-header h3")].map((node) => node.textContent);
    expect(headings).toEqual(["Overdue", "Today", "Later this week"]);
    expect(headings).not.toContain("Tomorrow");
  });

  it("navigates to the card for a card row and to the parent card for a checklist row", async () => {
    await render({
      response: payload({
        items: [
          item(),
          item({ kind: "checklistItem", id: "item-9", cardId: "parent-card", cardKey: "WORK-9", cardTitle: "Parent card", title: "A step" }),
        ],
      }),
    });
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, "navigate").mockResolvedValue(true);

    const rows = host().querySelectorAll<HTMLButtonElement>(".agenda-row");
    expect(rows[0].querySelector(".agenda-kind i")?.classList).toContain("ti-layout-kanban");
    expect(rows[1].querySelector(".agenda-kind i")?.classList).toContain("ti-list-check");
    rows[0].click();
    expect(navigate).toHaveBeenLastCalledWith(["/b", "board-1", "c", "card-1"], { browserUrl: "/o/0123456789ABCDEF/c/WORK-1" });

    // The checklist row deep-links to its parent card, not to its own id.
    rows[1].click();
    expect(navigate).toHaveBeenLastCalledWith(["/b", "board-1", "c", "parent-card"], { browserUrl: "/o/0123456789ABCDEF/c/WORK-9" });
  });

  it("shows each row's board with its own icon and colour, plus the card's labels", async () => {
    await render({
      response: payload({
        items: [item({
          boardIcon: "rocket",
          boardIconColor: "violet",
          labels: [
            { id: "label-1", name: "Bug", color: "rose" },
            { id: "label-2", name: "Untinted", color: null },
          ],
        })],
      }),
    });

    const chip = host().querySelector<HTMLElement>(".agenda-board")!;
    expect(chip.querySelector("i")!.className).toContain("ti-rocket");
    expect(chip.style.getPropertyValue("--board-color")).toBe("var(--color-violet)");
    expect(chip.textContent).toContain("Roadmap");
    expect(chip.textContent).toContain("Doing");

    // Labels render through the board's own k-card-labels chips, so the styling cannot drift
    // from the board and the shared compress/expand preference applies here too.
    const labels = [...host().querySelectorAll<HTMLElement>(".agenda-labels .label-chip")];
    expect(labels.map((label) => label.textContent?.trim())).toEqual(["Bug", "Untinted"]);
    expect(labels[0].style.getPropertyValue("--label-color")).toBe("var(--color-rose)");
    // A colourless label still renders, falling back to the neutral chip treatment.
    expect(labels[1].style.getPropertyValue("--label-color")).toBe("var(--border-strong)");
  });

  it("collapses a long group behind a working Show N more", async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      item({ id: `card-${index}`, cardId: `card-${index}`, bucket: "overdue", title: `Overdue ${index}` }));
    await render({
      response: payload({ items: many, counts: { ...payload().counts, overdueCards: 12 } }),
    });

    expect(host().querySelectorAll(".agenda-row")).toHaveLength(8);
    const more = host().querySelector<HTMLButtonElement>(".agenda-more")!;
    expect(more.textContent).toContain("Show 4 more");

    more.click();
    fixture.detectChanges();
    expect(host().querySelectorAll(".agenda-row")).toHaveLength(12);
  });

  it("links to the full list when the server truncated the horizon", async () => {
    await render({
      response: payload({
        items: [item({ bucket: "overdue" })],
        itemsTruncated: true,
        counts: { ...payload().counts, overdueCards: 140 },
      }),
    });

    const seeAll = host().querySelector<HTMLAnchorElement>(".agenda-see-all")!;
    expect(seeAll).not.toBeNull();
    expect(seeAll.getAttribute("href")).toBe("/my-cards");
  });

  it("shows the all-clear state when nothing is due this week", async () => {
    await render({ response: payload({ items: [] }) });

    expect(text()).toContain("You're all clear");
    expect(text()).toContain("Nothing assigned to you is due this week.");
    expect(host().querySelectorAll(".agenda-row")).toHaveLength(0);
  });

  it("renders the progress delta as up, down and level", async () => {
    await render();
    expect(host().querySelector(".progress-delta")!.textContent).toContain("+2 vs last week");
    expect(host().querySelector(".progress-delta.is-up")).not.toBeNull();

    TestBed.resetTestingModule();
    await render({
      response: payload({
        trend: {
          days: 28,
          byDay: [],
          thisWeek: { completedCards: 1 },
          lastWeek: { completedCards: 6 },
        },
      }),
    });
    // A down week is muted, not styled as danger.
    expect(host().querySelector(".progress-delta")!.textContent).toContain("-5 vs last week");
    expect(host().querySelector(".progress-delta.is-up")).toBeNull();

    TestBed.resetTestingModule();
    await render({
      response: payload({
        trend: {
          days: 28,
          byDay: [],
          thisWeek: { completedCards: 2 },
          lastWeek: { completedCards: 2 },
        },
      }),
    });
    expect(host().querySelector(".progress-delta")!.textContent).toContain("Level with last week");
  });

  it("shows an error with a working retry, and no blank page", async () => {
    const { get } = await render({ apiFails: true });

    expect(host().querySelector(".error-state")).not.toBeNull();
    expect(text()).toContain("We couldn’t load your day.");

    get.mockImplementation(async (path: string) =>
      path.startsWith("/home/today") ? payload() : {});
    host().querySelector<HTMLButtonElement>(".error-state button")!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(host().querySelector(".error-state")).toBeNull();
    expect(host().querySelectorAll(".agenda-row").length).toBeGreaterThan(0);
  });

  it("shows the offline banner instead of an error when a cached day is available", async () => {
    await render({
      apiFails: true,
      cached: { key: "client-1:user-1", cachedAt: "2026-07-26T08:00:00.000Z", response: payload() },
    });

    expect(host().querySelector(".error-state")).toBeNull();
    expect(host().querySelector(".offline-banner")).not.toBeNull();
    // The page stays useful — the agenda still renders from the snapshot.
    expect(host().querySelectorAll(".agenda-row").length).toBeGreaterThan(0);
  });

  it("resolves recent boards through WorkspaceService and drops unknown ids", async () => {
    localStorage.setItem(organisationStorageKey(STORAGE_KEYS.RECENT_BOARDS, "client-1"), JSON.stringify(["missing-board", "board-2", "board-1"]));

    await render();

    const chips = [...host().querySelectorAll(".recent-chip")].map((chip) => chip.textContent?.trim());
    expect(chips).toEqual(["Hiring Plan", "Roadmap"]);
    expect(text()).toContain("Recent boards");
    // Sits between the focus tiles and the agenda: both are quick exits off the page.
    const sections = [...host().querySelectorAll("section")].map((section) => section.className);
    expect(sections.indexOf("recent-section")).toBe(sections.indexOf("focus-grid") + 1);
    expect(sections.indexOf("agenda-section")).toBe(sections.indexOf("recent-section") + 1);
  });

  it("shows at most the five most recently used boards", async () => {
    localStorage.setItem(
      organisationStorageKey(STORAGE_KEYS.RECENT_BOARDS, "client-1"),
      JSON.stringify(["board-6", "board-5", "board-4", "board-3", "board-2", "board-1"]),
    );

    await render();

    const chips = [...host().querySelectorAll(".recent-chip")].map((chip) => chip.textContent?.trim());
    expect(chips).toEqual(["Archive", "Operations", "Research", "Launch", "Hiring Plan"]);
  });

  it("hides the recent strip when nothing has been visited", async () => {
    await render();
    expect(host().querySelector(".recent-strip")).toBeNull();
  });

  it("shows organisation admins a trial-status banner with an upgrade action", async () => {
    await render({
      isOrgAdmin: true,
      entitlements: {
        tier: "trial",
        billingStatus: "trialing",
        trialEndsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      },
    });

    expect(text()).toContain("Pro trial");
    expect(text()).toContain("Your Pro trial is active");
    expect(text()).toContain("5 days left");
    const action = host().querySelector<HTMLAnchorElement>(".account-status-action");
    expect(action?.textContent).toContain("Choose Pro");
    expect(action?.getAttribute("href")).toBe("/settings/account-plan");
  });

  it("shows free, paid, and past-due account states with contextual actions", async () => {
    await render({
      isOrgAdmin: true,
      entitlements: { tier: "free", billingStatus: "none", maxBoards: 3 },
    });
    expect(text()).toContain("Your organisation is on Kanera Free");
    expect(text()).toContain("3 boards active");
    expect(text()).toContain("Upgrade to Pro");

    TestBed.resetTestingModule();
    await render({
      isOrgAdmin: true,
      entitlements: { tier: "paid", billingStatus: "active" },
    });
    expect(text()).toContain("Kanera Pro is active");
    expect(text()).toContain("Manage plan");

    TestBed.resetTestingModule();
    await render({
      isOrgAdmin: true,
      entitlements: { tier: "paid", billingStatus: "past_due" },
    });
    expect(text()).toContain("Payment issue");
    expect(text()).toContain("payment needs attention");
    expect(text()).toContain("Review billing");
  });

  it("shows owners the concrete Pro value their team has used", async () => {
    await render({
      isOrgAdmin: true,
      role: "owner",
      response: payload({
        proUsage: {
          capabilityCount: 7,
          memberCount: 6,
          boardCount: 4,
          automationCount: 3,
          apiConnection: true,
          guestCount: 2,
        },
      }),
      entitlements: { tier: "trial", billingStatus: "trialing" },
    });

    expect(text()).toContain("Your team has used 7 Pro capabilities this month");
    expect(text()).toContain("6 users · 4 boards · 3 automations · API connection · 2 guests");
  });

  it("does not turn paid or past-due account status into a usage comparison", async () => {
    const proUsage = {
      capabilityCount: 7,
      memberCount: 6,
      boardCount: 4,
      automationCount: 3,
      apiConnection: true,
      guestCount: 2,
    };

    await render({
      isOrgAdmin: true,
      role: "owner",
      response: payload({ proUsage }),
      entitlements: { tier: "paid", billingStatus: "active" },
    });
    expect(text()).toContain("Kanera Pro is active");
    expect(text()).not.toContain("Your team has used");

    TestBed.resetTestingModule();
    await render({
      isOrgAdmin: true,
      role: "owner",
      response: payload({ proUsage }),
      entitlements: { tier: "paid", billingStatus: "past_due" },
    });
    expect(text()).toContain("Payment issue");
    expect(text()).not.toContain("Your team has used");
  });

  it("shows Free automation executions remaining to organisation owners", async () => {
    await render({
      isOrgAdmin: true,
      role: "owner",
      response: payload({ automationExecutionsRemaining: 72 }),
      entitlements: { tier: "free", billingStatus: "none", maxBoards: 3 },
    });

    expect(text()).toContain("72 automation executions left this month");
  });

  it("does not show Free automation executions remaining to organisation admins", async () => {
    await render({
      isOrgAdmin: true,
      role: "admin",
      response: payload({ automationExecutionsRemaining: 72 }),
      entitlements: { tier: "free", billingStatus: "none", maxBoards: 3 },
    });

    expect(text()).not.toContain("72 automation executions left this month");
  });

  it("shows self-hosted status to admins and hides account status from regular members", async () => {
    await render({
      isOrgAdmin: true,
      deploymentMode: "self_hosted",
      entitlements: { tier: "paid", billingStatus: "none" },
    });
    expect(text()).toContain("Self-hosted");
    expect(text()).toContain("Unlimited access is active");
    expect(text()).toContain("Account settings");

    TestBed.resetTestingModule();
    await render({
      isOrgAdmin: false,
      entitlements: { tier: "trial", billingStatus: "trialing" },
    });
    expect(host().querySelector(".account-status-banner")).toBeNull();
  });

  it("shows the getting-started empty state and suppresses the daily-driver sections", async () => {
    await render({ hasWorkspace: false, isOrgAdmin: true, response: payload({ boardCount: 0 }) });

    expect(text()).toContain("No boards yet");
    expect(host().querySelector(".focus-grid")).toBeNull();
    expect(host().querySelector(".agenda-panel")).toBeNull();
    expect(host().querySelector(".progress-panel")).toBeNull();
  });

  it("renders the full page for a standalone-only account, which reports no workspace", async () => {
    // Regression guard: `hasWorkspace` excludes standalone and guest boards, so gating the empty
    // state on it hid a real agenda behind a "no workspaces" lock.
    await render({
      hasWorkspace: false,
      isOrgAdmin: true,
      response: payload({ boardCount: 1 }),
      registeredBoards: [{ id: "board-1", name: "Roadmap", icon: null, iconColor: null }],
    });

    expect(text()).not.toContain("No boards yet");
    expect(host().querySelectorAll(".stat-tile")).toHaveLength(4);
    expect(host().querySelector(".agenda-panel")).not.toBeNull();
    expect(host().querySelector(".progress-panel")).not.toBeNull();
    // No visit history in this fixture, so the strip falls back to the registered board list.
    expect(text()).toContain("Recent boards");
    expect([...host().querySelectorAll(".recent-chip")].map((chip) => chip.textContent?.trim())).toEqual(["Roadmap"]);
  });

  it("blocks workspace creation and explains the board limit", async () => {
    await render({
      hasWorkspace: false,
      isOrgAdmin: true,
      entitlements: { maxBoards: 0 },
      response: payload({ boardCount: 0 }),
    });

    host().querySelector<HTMLButtonElement>(".no-boards-actions button:last-of-type")!.click();
    fixture.detectChanges();

    expect(text()).toContain("Your plan allows 0 boards. Upgrade to add another workspace.");
  });

  it("blocks standalone board creation and explains the board limit", async () => {
    await render({
      hasWorkspace: false,
      isOrgAdmin: true,
      entitlements: { maxBoards: 0 },
      response: payload({ boardCount: 0 }),
    });

    host().querySelector<HTMLButtonElement>(".no-boards-actions button")!.click();
    fixture.detectChanges();

    expect(text()).toContain("Your plan allows 0 boards. Upgrade to add another board.");
  });
});
