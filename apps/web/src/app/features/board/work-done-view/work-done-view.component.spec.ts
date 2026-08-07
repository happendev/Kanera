import { provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import type { GlobalWorkDoneQuery, WorkDoneEvent, WorkDoneResponse } from "@kanera/shared/dto";
import type { WireCardSummary } from "@kanera/shared/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../../core/api/api.client";
import { localDateKey } from "../../../shared/day-key.util";
import { BoardMenuCoordinator } from "../board-menu-coordinator.service";
import { BoardState } from "../board-state";
import { WorkDoneViewComponent } from "./work-done-view.component";

function cardSummary(overrides: Partial<WireCardSummary> & { id: string; title: string }): WireCardSummary {
  return {
    listId: "list-1",
    boardId: "board-1",
    position: "1000.0000000000",
    dueDateLocalDate: null,
    dueDateSlot: null,
    dueDateTimezone: null,
    completedAt: null,
    archivedAt: null,
    coverAttachmentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    hasDescription: false,
    commentCount: 0,
    attachmentCount: 0,
    checklistDoneCount: 0,
    checklistTotalCount: 0,
    coverUrl: null,
    labelIds: [],
    assigneeIds: [],
    customFieldValues: [],
    ...overrides,
  } as WireCardSummary;
}

/**
 * Events must be stamped in the runner's local zone: the view buckets rows by local calendar day, so
 * a hardcoded UTC string would land on a different day depending on where the suite runs.
 */
function todayAt(hour: number, minute = 0): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute).toISOString();
}

function yesterdayAt(hour: number): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour).toISOString();
}

describe("WorkDoneViewComponent", () => {
  let fixture: ComponentFixture<WorkDoneViewComponent>;
  let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    window.localStorage.clear();
    api = { get: vi.fn(), post: vi.fn() };
    const boardState = {
      cardLabels: signal([{ id: "label-1", name: "Billing", color: "blue" }]),
      members: signal([{ userId: "user-1", displayName: "Ada", avatarUrl: null, role: "editor", source: "workspace" }]),
      customFields: signal([]),
    };

    await TestBed.configureTestingModule({
      imports: [WorkDoneViewComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        { provide: BoardState, useValue: boardState },
        // Row label chips reuse k-card-labels, which reads the shared compress-labels toggle. All
        // both host pages provide it; the test scope must too.
        BoardMenuCoordinator,
      ],
    }).compileComponents();
  });

  async function render(response: WorkDoneResponse, inputs?: Record<string, unknown>) {
    // Both the timeline and the activity-strip summary go through the same client; the strip's
    // response shape is ignored by these assertions.
    api.get.mockResolvedValue(response);
    api.post.mockResolvedValue(response);
    fixture = TestBed.createComponent(WorkDoneViewComponent);
    fixture.componentRef.setInput("scope", "board");
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("lists", [
      { id: "list-1", name: "To Do", color: null, icon: null },
      { id: "list-2", name: "Done", color: null, icon: null },
    ]);
    for (const [key, value] of Object.entries(inputs ?? {})) fixture.componentRef.setInput(key, value);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  /** Only the timeline request, ignoring the strip's `/summary` call. */
  function timelineGetUrl(): string | undefined {
    return api.get.mock.calls.map((call) => call[0] as string).find((url) => !url.includes("/summary"));
  }

  const createdEvent: WorkDoneEvent = {
    id: "act-created",
    type: "created",
    at: todayAt(8),
    card: cardSummary({ id: "card-1", title: "Ship it" }),
    boardId: "board-1",
    listId: "list-1",
    actorUserId: "user-1",
    actorName: "Ada",
    actorAvatarUrl: null,
  };
  const movedEvent: WorkDoneEvent = {
    id: "act-moved",
    type: "moved",
    at: todayAt(9),
    card: cardSummary({ id: "card-1", title: "Ship it", listId: "list-2" }),
    boardId: "board-1",
    listId: "list-2",
    actorUserId: "user-2",
    actorName: "Bob",
    actorAvatarUrl: null,
    listPath: ["list-1", "list-2"],
  };
  const completedEvent: WorkDoneEvent = {
    id: "act-completed",
    type: "completed",
    at: todayAt(10),
    card: cardSummary({ id: "card-2", title: "Wrap up" }),
    boardId: "board-1",
    listId: "list-2",
    actorUserId: "user-1",
    actorName: "Ada",
    actorAvatarUrl: null,
  };
  const checklistEvent: WorkDoneEvent = {
    id: "checklistItem:item-1",
    type: "checklistItemCompleted",
    at: todayAt(11),
    card: cardSummary({ id: "card-3", title: "Release" }),
    boardId: "board-1",
    listId: "list-2",
    itemId: "item-1",
    text: "Verify production deploy",
    checklistId: "checklist-1",
    checklistTitle: "Release checks",
    completedByUserId: "user-1",
    completedByName: "Ada",
    completedByAvatarUrl: null,
  };

  it("renders one row per card, per person, per day, newest activity first", async () => {
    const native = await render({ events: [checklistEvent, completedEvent, movedEvent, createdEvent] });

    // Four events over three cards, all today. "Ship it" was created by Ada and moved by Bob, so it
    // takes a row each: four events, four rows.
    expect(native.querySelectorAll("k-work-done-day")).toHaveLength(1);
    const titles = Array.from(native.querySelectorAll(".wd-card-title")).map((el) => el.textContent?.trim());
    expect(titles).toEqual(["Release", "Wrap up", "Ship it", "Ship it"]);
    expect(native.querySelector(".wd-summary")?.textContent).toContain("4 events");
    // The header still counts cards, not rows.
    expect(native.querySelector(".wd-day-cards")?.textContent?.trim()).toBe("3 cards");
  });

  it("collapses one person's milestones on a card into a single row led by its outcome", async () => {
    // Same actor on both events, so they belong to the same person's row.
    const native = await render({ events: [{ ...movedEvent, actorUserId: "user-1", actorName: "Ada" }, createdEvent] });

    const rows = native.querySelectorAll(".wd-row");
    expect(rows).toHaveLength(1);
    // Both milestones are present on the one row.
    expect(rows[0]!.querySelector(".wd-chip--created")).not.toBeNull();
    const path = Array.from(rows[0]!.querySelectorAll(".wd-list-name")).map((el) => el.textContent?.trim());
    expect(path).toEqual(["To Do", "Done"]);
  });

  it("splits a card's day across the people who worked it", async () => {
    // Ada created it, Bob moved it: two rows, each crediting one person by first name.
    const native = await render({ events: [movedEvent, createdEvent] });

    const rows = native.querySelectorAll(".wd-row");
    expect(rows).toHaveLength(2);
    const credited = Array.from(native.querySelectorAll(".wd-actor-name")).map((el) => el.textContent?.trim());
    // Newest first: Bob's move at 09:00, then Ada's creation at 08:00.
    expect(credited).toEqual(["Bob", "Ada"]);
    expect(rows[0]!.querySelector(".wd-verb")?.textContent?.trim()).toBe("Moved");
    expect(rows[1]!.querySelector(".wd-verb")?.textContent?.trim()).toBe("Created");
    // Each row carries only its own person's milestone.
    expect(rows[0]!.querySelector(".wd-chip--created")).toBeNull();
  });

  it("splits a card's activity across days into one row per day", async () => {
    const native = await render({
      events: [
        { ...movedEvent, id: "act-today", at: todayAt(9) },
        { ...movedEvent, id: "act-yesterday", at: yesterdayAt(14) },
      ],
    });

    const days = native.querySelectorAll("k-work-done-day");
    expect(days).toHaveLength(2);
    expect(days[0]!.querySelector(".wd-day-label")?.textContent?.trim()).toBe("Today");
    expect(days[1]!.querySelector(".wd-day-label")?.textContent?.trim()).toBe("Yesterday");
    expect(native.querySelectorAll(".wd-row")).toHaveLength(2);
  });

  it("places the same day components in the responsive grid layout", async () => {
    const native = await render({
      events: [
        completedEvent,
        { ...movedEvent, id: "act-moved-yesterday", at: yesterdayAt(14) },
      ],
    }, { layout: "grid" });

    expect(native.querySelector(".wd-stream")?.classList.contains("wd-stream-grid")).toBe(true);
    expect(native.querySelectorAll("k-work-done-day")).toHaveLength(2);
    expect(native.querySelectorAll(".wd-row")).toHaveLength(2);
  });

  it("summarises each day with per-type counts and its contributors", async () => {
    const native = await render({ events: [checklistEvent, completedEvent, movedEvent, createdEvent] });

    expect(native.querySelector(".wd-day-cards")?.textContent?.trim()).toBe("3 cards");
    const counts = Array.from(native.querySelectorAll(".wd-count")).map((el) => el.textContent?.trim());
    // One of each type, rendered in reading order: completed, checklist, moved, created.
    expect(counts).toEqual(["1", "1", "1", "1"]);
    // Ada (3 events) and Bob (1) both appear in the day's contributor stack.
    expect(native.querySelectorAll(".wd-day-actors k-avatar")).toHaveLength(2);
  });

  it("keeps every count slot on every day so the columns align down the stream", async () => {
    const native = await render({
      events: [
        // Today: one completion only. Yesterday: one move only.
        completedEvent,
        { ...movedEvent, id: "act-moved-yesterday", at: yesterdayAt(14) },
      ],
    });

    const days = native.querySelectorAll("k-work-done-day");
    expect(days).toHaveLength(2);
    for (const day of Array.from(days)) {
      // All four metrics are present in both headers, zeroes included, so nothing reflows per day.
      expect(day.querySelectorAll(".wd-count")).toHaveLength(4);
    }
    // Today's completion is non-zero; its other three slots are dimmed placeholders.
    expect(days[0]!.querySelectorAll(".wd-count.is-zero")).toHaveLength(3);
    expect(days[0]!.querySelector(".wd-count--completed")?.classList.contains("is-zero")).toBe(false);
    expect(days[1]!.querySelector(".wd-count--moved")?.classList.contains("is-zero")).toBe(false);
    expect(days[1]!.querySelector(".wd-count--completed")?.classList.contains("is-zero")).toBe(true);
  });

  it("collapses the middle of long move paths", async () => {
    const list = (id: string, name: string) => ({ id, name, color: null, icon: null });
    const longMove: WorkDoneEvent = {
      id: "act-long-move",
      type: "moved",
      at: todayAt(9),
      card: cardSummary({ id: "card-9", title: "Wanderer" }),
      boardId: "board-1",
      listId: "list-e",
      actorUserId: "user-1",
      actorName: "Ada",
      actorAvatarUrl: null,
      listPath: ["list-a", "list-b", "list-c", "list-d", "list-e"],
    };
    const native = await render({ events: [longMove] }, {
      lists: [list("list-a", "A"), list("list-b", "B"), list("list-c", "C"), list("list-d", "D"), list("list-e", "E")],
    });

    const segments = Array.from(native.querySelectorAll(".wd-chip--moved span")).map((el) => el.textContent?.trim());
    // First 3 lists, an ellipsis, then the final destination.
    expect(segments).toEqual(["A", "B", "C", "…", "E"]);
  });

  it("shows label chips on rows", async () => {
    const native = await render({
      events: [{
        ...completedEvent,
        card: cardSummary({ id: "card-2", title: "Wrap up", labelIds: ["label-1"] }),
      }],
    });

    expect(native.querySelector(".label-chip")?.textContent?.trim()).toBe("Billing");
  });

  it("credits only the people who did the work, never the card's assignees", async () => {
    // Bob did it; Ada owns it. This view answers "what happened", so only Bob is on the row.
    const native = await render({
      events: [{
        ...completedEvent,
        actorUserId: "user-2",
        actorName: "Bob",
        card: cardSummary({ id: "card-2", title: "Wrap up", assigneeIds: ["user-1"] }),
      }],
    });

    expect(native.querySelectorAll(".wd-actors k-avatar")).toHaveLength(1);
    expect(native.querySelector(".wd-assignees")).toBeNull();
  });

  it("leads each row with its time and the outcome verb, without repeating it as a chip", async () => {
    const native = await render({ events: [movedEvent, createdEvent, completedEvent] });

    const row = native.querySelectorAll(".wd-row")[0]!;
    // Newest card first, so card-2 — completed at 10:00 local — leads.
    expect(row.querySelector(".wd-time")?.textContent?.trim()).toBe(
      new Date(completedEvent.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    );
    expect(row.querySelector(".wd-verb")?.textContent?.trim()).toBe("Completed");
    expect(row.querySelector(".wd-verb--completed")).not.toBeNull();
    expect(row.querySelector(".wd-chip--completed")).toBeNull();
  });

  it("clicking a row opens the card", async () => {
    const native = await render({ events: [completedEvent] });
    const opened = vi.fn();
    const summaryOpened = vi.fn();
    fixture.componentInstance.cardOpened.subscribe(opened);
    fixture.componentInstance.cardSummaryOpened.subscribe(summaryOpened);

    native.querySelector<HTMLElement>(".wd-row")?.click();

    expect(opened).toHaveBeenCalledWith("card-2");
    expect(summaryOpened).toHaveBeenCalledWith(completedEvent.card);
  });

  it("marks the selected card's row", async () => {
    const native = await render({ events: [completedEvent, createdEvent] }, { selectedCardId: "card-2" });

    const selected = native.querySelectorAll(".wd-row.is-selected");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.querySelector(".wd-card-title")?.textContent?.trim()).toBe("Wrap up");
  });

  it("requests the selected period with the viewer's time zone", async () => {
    await render({ events: [] });

    const url = timelineGetUrl()!;
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    // The default 7-day preset spans 7 local days, sent as an exclusive upper bound.
    const from = new Date(params.get("from")!);
    const to = new Date(params.get("to")!);
    expect(Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000))).toBe(7);
    expect(params.get("timeZone")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("narrows to a single day when the Today preset is chosen", async () => {
    await render({ events: [] });
    api.get.mockClear();

    fixture.componentInstance.applyPreset("today");
    fixture.detectChanges();
    await fixture.whenStable();

    const url = timelineGetUrl()!;
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    const span = new Date(params.get("to")!).getTime() - new Date(params.get("from")!).getTime();
    expect(Math.round(span / (24 * 60 * 60 * 1000))).toBe(1);
  });

  it("filters the timeline from the host-owned page filter without refetching", async () => {
    const native = await render({ events: [checklistEvent, completedEvent, movedEvent, createdEvent] });
    const requestCount = api.get.mock.calls.length;

    fixture.componentRef.setInput("eventTypeFilter", "completed");
    fixture.detectChanges();
    await fixture.whenStable();

    expect(Array.from(native.querySelectorAll(".wd-card-title")).map((el) => el.textContent?.trim()))
      .toEqual(["Wrap up"]);
    expect(native.querySelector(".wd-summary")?.textContent).toContain("1 event");
    expect(fixture.componentInstance.activitySeries().map((series) => series.key)).toEqual(["completed"]);
    // The bounded event page is already loaded; changing type is an instant local filter.
    expect(api.get.mock.calls).toHaveLength(requestCount);

    fixture.componentRef.setInput("eventTypeFilter", null);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(native.querySelectorAll(".wd-card-title")).toHaveLength(4);
    expect(api.get.mock.calls).toHaveLength(requestCount);
  });

  it("loads the activity strip over a fixed window, independent of the visible period", async () => {
    await render({ events: [] });

    const summaryUrl = api.get.mock.calls.map((call) => call[0] as string).find((url) => url.includes("/summary"));
    expect(summaryUrl).toBeDefined();
    const params = new URLSearchParams(summaryUrl!.slice(summaryUrl!.indexOf("?") + 1));
    const span = new Date(params.get("to")!).getTime() - new Date(params.get("from")!).getTime();
    // 56-day strip window, wider than any preset, so it can show where the busy days are.
    expect(Math.round(span / (24 * 60 * 60 * 1000))).toBe(56);
  });

  it("sends list, label and member filters to the strip so it cannot overstate the timeline", async () => {
    await render({ events: [] }, {
      filterListIds: ["list-2"],
      filterLabelIds: ["label-1"],
      filterMemberIds: ["user-1"],
    });

    const summaryUrl = api.get.mock.calls.map((call) => call[0] as string).find((url) => url.includes("/summary"))!;
    const params = new URLSearchParams(summaryUrl.slice(summaryUrl.indexOf("?") + 1));
    // An aggregate cannot be narrowed client-side, so these have to reach the server.
    expect(params.getAll("listIds")).toEqual(["list-2"]);
    expect(params.getAll("labelIds")).toEqual(["label-1"]);
    expect(params.getAll("actorIds")).toEqual(["user-1"]);
  });

  it("flags the strip as unnarrowed when custom-field filters are active", async () => {
    const plain = await render({ events: [] });
    expect(plain.querySelector("k-activity-strip header strong")?.textContent?.trim()).toBe("Activity");

    const filtered = await render({ events: [] }, {
      filterCfConditions: [{ fieldId: "field-1", op: "isNotEmpty" }],
    });
    // Custom-field conditions are the one dimension the aggregate cannot express, so it says so.
    expect(filtered.querySelector("k-activity-strip header strong")?.textContent?.trim())
      .toBe("Activity · before field filters");
  });

  it("loads global work-done with the lens, accessible scope, and current filters", async () => {
    await render({ events: [createdEvent] }, {
      scope: "global",
      boardId: null,
      globalLens: "team",
      globalScope: {
        allAccessible: false,
        organisationIds: [],
        workspaceIds: ["workspace-1"],
        boardIds: [],
      },
      globalFilters: {
        q: "ship",
        assigneeIds: ["user-1"],
        listIds: [],
        labelIds: [],
        customFieldConditions: [],
        completion: "active",
        unassignedOnly: false,
        dueFrom: null,
        dueTo: null,
        overdueOnly: false,
        overdueChecklistOnly: false,
        unreadOnly: false,
        archived: false,
        completedFrom: null,
        completedTo: null,
      },
    });

    const call = api.post.mock.calls
      .find(([url]) => url === "/work/work-done/query") as [string, GlobalWorkDoneQuery] | undefined;
    expect(call?.[1].lens).toBe("team");
    expect(call?.[1].scope?.workspaceIds).toEqual(["workspace-1"]);
    expect(call?.[1].filters?.q).toBe("ship");
    expect(call?.[1].filters?.assigneeIds).toEqual(["user-1"]);
    expect(call?.[1].timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // The strip goes to its own aggregate endpoint under the same lens and scope.
    const summaryCall = api.post.mock.calls.find(([url]) => url === "/work/work-done/summary/query");
    expect(summaryCall).toBeDefined();
  });

  it("member filter keeps card events by actor and checklist events by completedBy", async () => {
    // movedEvent's actor is user-2; created/completed/checklist are user-1.
    const native = await render(
      { events: [checklistEvent, completedEvent, movedEvent, createdEvent] },
      { filterMemberIds: ["user-1"] },
    );

    const titles = Array.from(native.querySelectorAll(".wd-card-title")).map((el) => el.textContent?.trim());
    // Ship it survives via its created event; the moved event (user-2) is filtered out, so its row
    // no longer shows a move path.
    expect(titles).toEqual(["Release", "Wrap up", "Ship it"]);
    expect(native.querySelector(".wd-chip--moved")).toBeNull();
  });

  it("shows a filter-aware empty state when nothing matches", async () => {
    const native = await render({ events: [completedEvent] }, { filterMemberIds: ["nobody"] });

    expect(native.querySelector(".wd-empty-panel strong")?.textContent?.trim()).toBe("No matching work done");
    expect(native.querySelectorAll(".wd-row")).toHaveLength(0);
  });

  it("collapsing a day hides its rows but keeps its summary", async () => {
    const native = await render({ events: [completedEvent] });
    expect(native.querySelectorAll(".wd-row")).toHaveLength(1);

    fixture.componentInstance.toggleDay(fixture.componentInstance.days()[0]!.dateKey);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(native.querySelectorAll(".wd-row")).toHaveLength(0);
    expect(native.querySelector(".wd-day-cards")?.textContent?.trim()).toBe("1 card");
  });

  it("uses host-owned day folds and reports changes", async () => {
    const dateKey = localDateKey(new Date());
    const native = await render(
      { events: [completedEvent] },
      { hostCollapsedDayKeys: [dateKey] },
    );
    const emitted: string[][] = [];
    fixture.componentInstance.hostCollapsedDayKeysChange.subscribe((keys) => emitted.push(keys));

    expect(native.querySelectorAll(".wd-row")).toHaveLength(0);

    fixture.componentInstance.toggleDay(dateKey);
    expect(emitted).toEqual([[]]);
  });
});
