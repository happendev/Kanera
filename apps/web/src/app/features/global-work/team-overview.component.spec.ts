import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { WorkCatalogPerson, WorkDoneEvent, WorkPriorityQueue } from "@kanera/shared/dto";
import { expandCardSummary, type CompactCardSummary, type WireCardSummary } from "@kanera/shared/events";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { CachedViewService } from "../../core/offline/cached-view.service";
import { CardKeyDisplayService } from "../../shared/card-key-display.service";
import { TeamOverviewComponent } from "./team-overview.component";

/**
 * The overview's per-person derivation, rendered without its template: what each section lists
 * and what the header claims. Failure modes covered here:
 * - the Up next head rows are subtracted from Assigned while the inline Up next section is hidden
 *   because the queue is docked, so the panel silently drops the person's top-ranked cards;
 * - "No activity in 7 days" sits directly above a non-zero Done 7d.
 */

const USER = "60000000-0000-4000-8000-000000000001";
const BOARD = "30000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const LIST = "50000000-0000-4000-8000-000000000001";

const person: WorkCatalogPerson = {
  userId: USER,
  organisationId: "10000000-0000-4000-8000-000000000001",
  displayName: "Priya Nair",
  avatarUrl: null,
  boardIds: [BOARD],
  guestBoardIds: [],
};

function card(n: number, overrides: Partial<CompactCardSummary> = {}): WireCardSummary {
  return expandCardSummary({
    id: `40000000-0000-4000-8000-00000000000${n}`,
    workspaceId: WORKSPACE,
    organisationKey: "0123456789ABCDEF",
    number: n,
    key: `DEV-${n}`,
    listId: LIST,
    boardId: BOARD,
    title: `Card ${n}`,
    position: `${n}000.0000000000`,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date(`2026-07-0${n}T00:00:00.000Z`),
    assigneeIds: [USER],
    ...overrides,
  } as CompactCardSummary);
}

const cards = [1, 2, 3, 4, 5].map((n) => card(n));

/** Every open card queued, in number order, so the inline section shows ranks 1–3. */
const queue: WorkPriorityQueue = {
  target: { userId: USER, displayName: person.displayName, email: "priya@kanera.test", self: true, workspaceIds: [WORKSPACE], queueSize: 5 },
  queue: {
    targetUserId: USER,
    items: cards.map((item, index) => ({
      id: `p${index + 1}`,
      position: `${index + 1}000.0000000000`,
      rank: index + 1,
      card: item,
      context: { boardName: "Platform", boardIcon: null, boardIconColor: null, listName: "Backlog", listIcon: null, listColor: null, workspaceName: "Dev", labels: [] },
    })) as unknown as WorkPriorityQueue["queue"]["items"],
    totalCount: 5,
    hiddenCount: 0,
    canReorder: true,
    reorderableWorkspaceIds: [WORKSPACE],
  },
};

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiClient, useValue: {} },
      // Reads never settle: these tests drive the activity feed through `events` directly.
      { provide: CachedViewService, useValue: { online: () => true, read: () => new Promise(() => undefined) } },
      { provide: CardKeyDisplayService, useValue: { showCardKeys: () => true } },
    ],
  });
  TestBed.overrideComponent(TeamOverviewComponent, { set: { template: "", imports: [] } });
  const fixture = TestBed.createComponent(TeamOverviewComponent);
  fixture.componentRef.setInput("lens", "my");
  fixture.componentRef.setInput("people", [person]);
  fixture.componentRef.setInput("cards", cards);
  fixture.componentRef.setInput("queues", [queue]);
  fixture.componentRef.setInput("focusedUserId", USER);
  fixture.detectChanges();
  return fixture;
}

describe("TeamOverviewComponent", () => {
  beforeEach(() => TestBed.resetTestingModule());

  it("leaves the inline Up next rows out of Assigned only while that section is shown", () => {
    const fixture = setup();
    const overview = () => fixture.componentInstance.overviews()[0]!;
    const assignedTitles = () => overview().assigned.map((row) => row.card.title);

    expect(overview().upNext?.rows.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(assignedTitles().sort()).toEqual(["Card 4", "Card 5"]);

    // Docked: the dock is a separate pane and the inline section is not rendered, so the panel's
    // own sections must still list ranks 1–3 rather than dropping them.
    fixture.componentRef.setInput("upNextOpen", true);
    fixture.detectChanges();
    expect(assignedTitles().sort()).toEqual(["Card 1", "Card 2", "Card 3", "Card 4", "Card 5"]);
    expect(overview().assignedMore).toBe(0);
  });

  it("does not claim no activity above a Done 7d credited from a hands-off completion", () => {
    const fixture = setup();
    const component = fixture.componentInstance;
    const done = card(6, { completedAt: new Date("2026-07-06T00:00:00.000Z") });
    component.events.set([{
      id: "e1",
      type: "completed",
      at: "2026-07-06T00:00:00.000Z",
      card: done,
      boardId: BOARD,
      listId: LIST,
      actorUserId: null,
      actorName: "Automation",
      actorAvatarUrl: null,
      agentName: null,
    } satisfies WorkDoneEvent]);
    const overview = component.overviews()[0]!;

    expect(overview.done).toBe(1);
    expect(overview.lastActiveAt).toBeNull();
    expect(component.showLastActive(overview)).toBe(false);

    // With nothing done either, "No activity in 7 days" is simply true and still shows.
    component.events.set([{
      id: "e2",
      type: "moved",
      at: "2026-07-06T00:00:00.000Z",
      card: done,
      boardId: BOARD,
      listId: LIST,
      actorUserId: null,
      actorName: "API",
      actorAvatarUrl: null,
      agentName: null,
      listPath: [LIST],
    } satisfies WorkDoneEvent]);
    expect(component.showLastActive(component.overviews()[0]!)).toBe(true);
  });
});
