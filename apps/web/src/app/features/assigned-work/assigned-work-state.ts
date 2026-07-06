import { Injectable, computed, signal } from "@angular/core";
import type {
  WireAssignedBoardSummary,
  WireAssignedWorkPayload,
  WireAssignedWorkTargetUser,
  WireCardSummary,
  WireChecklistAssignment,
} from "@kanera/shared/events";
import { BoardState } from "../board/board-state";

// AssignedWorkState reuses BoardState's signal layout so the board page's list/card
// components work unchanged. The differences live in hydrate() and the multi-board
// helpers below: instead of one board, we track a set of accessible boards plus the
// target user whose assigned cards drive the feed.
@Injectable()
export class AssignedWorkState extends BoardState {
  readonly boards = signal<WireAssignedBoardSummary[]>([]);
  readonly targetUser = signal<WireAssignedWorkTargetUser | null>(null);
  readonly memberOverdueCounts = signal<Map<string, number>>(new Map());
  // Overdue assigned checklist items per member, tracked separately from card overdue counts
  // so the team tab badges can reflect both entity types.
  readonly memberOverdueChecklistCounts = signal<Map<string, number>>(new Map());
  // Checklist items assigned to the target user, surfaced as a dedicated "My checklist items"
  // section rather than folded into the card grid (the board/list/calendar views assume cards).
  readonly checklistItems = signal<WireChecklistAssignment[]>([]);

  readonly boardsById = computed(() => new Map(this.boards().map((b) => [b.id, b])));

  isBoardVisible(boardId: string): boolean {
    return this.boardsById().has(boardId);
  }

  hydrateAssignedWork(payload: WireAssignedWorkPayload) {
    // Reuse BoardState.hydrate by synthesising a virtual board whose workspace ID
    // matches the real one, so workspace-scoped event filters keep working.
    const virtualBoard = {
      id: `assigned:${payload.workspace.id}:${payload.targetUser.userId}`,
      workspaceId: payload.workspace.id,
      groupId: null,
      name: payload.workspace.name,
      description: null,
      icon: null,
      iconColor: null,
      backgroundGradient: null,
      position: "0",
      archivedAt: null,
      createdAt: payload.workspace.createdAt,
      updatedAt: payload.workspace.updatedAt,
    };
    super.hydrate({
      board: virtualBoard,
      lists: payload.lists,
      cards: payload.cards,
      separators: payload.separators ?? [],
      customFields: payload.customFields,
      cardLabels: payload.cardLabels,
      members: payload.members,
      // Assigned-work carries a workspace role (admin/member), but the shared board state gates card
      // editing on a board role. Everyone with assigned-work access can act on cards in the view, so
      // map both workspace roles to the editor board role.
      viewerRole: "editor",
    });
    this.boards.set(payload.boards);
    this.targetUser.set(payload.targetUser);
    this.memberOverdueCounts.set(new Map(payload.memberStats.map((stat) => [stat.userId, stat.overdueCards])));
    this.memberOverdueChecklistCounts.set(new Map(payload.memberStats.map((stat) => [stat.userId, stat.overdueChecklistItems])));
    this.checklistItems.set(payload.checklistItems);
  }

  override clear() {
    super.clear();
    this.boards.set([]);
    this.targetUser.set(null);
    this.memberOverdueCounts.set(new Map());
    this.memberOverdueChecklistCounts.set(new Map());
    this.checklistItems.set([]);
  }

  upsertCardSummary(card: WireCardSummary) {
    this.upsertCard(card);
  }

  // Add or replace an item in the target user's "My checklist items" list (keyed by itemId).
  // Named distinctly from BoardState.addChecklistItem/removeChecklistItem, which manage the
  // per-card checklist substate and must keep working unchanged.
  upsertAssignedChecklistItem(item: WireChecklistAssignment) {
    this.checklistItems.update((items) => {
      const next = items.filter((existing) => existing.itemId !== item.itemId);
      next.push(item);
      return next;
    });
  }

  removeAssignedChecklistItem(itemId: string) {
    this.checklistItems.update((items) => items.filter((existing) => existing.itemId !== itemId));
  }
}
