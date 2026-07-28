import type { OnDestroy, OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, inject, input, output, signal } from "@angular/core";
import type { WorkCard, WorkCatalog } from "@kanera/shared/dto";
import type { CompactCardSummary, WireBoardMemberUser, WireChecklistTemplate } from "@kanera/shared/events";
import { expandCardSummary } from "@kanera/shared/events";
import type { Board, BoardRole, CardLabel, CustomField, List } from "@kanera/shared/schema";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { SocketService, type AppSocket } from "../../core/realtime/socket.service";
import { BoardSocketBridge } from "../board/board-socket-bridge";
import { BoardState } from "../board/board-state";
import { CardDetailComponent } from "../board/card-detail.component";

type SourceBoardPayload = {
  board: Board;
  workspaceClientId?: string | null;
  workspaceKind?: "standard" | "board";
  boardLinkingEnabled?: boolean;
  hasMirrors?: boolean;
  lists: List[];
  customFields: CustomField[];
  cardLabels: CardLabel[];
  checklistTemplates: WireChecklistTemplate[];
  members: WireBoardMemberUser[];
  viewerRole: BoardRole;
  viewerSource?: "board" | "workspace";
  viewerCanAccessWorkspace?: boolean;
  viewerIsWorkspaceAdmin?: boolean;
  viewerAssignedItemsOnly?: boolean;
};

@Component({
  selector: "k-global-card-detail-host",
  standalone: true,
  imports: [CardDetailComponent],
  providers: [BoardState, BoardSocketBridge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ready()) {
      <k-card-detail
        [card]="cardSummary()"
        [boardId]="card().boardId"
        [customFields]="state.customFields()"
        [customFieldValues]="state.customFieldValues()"
        [cardLabels]="state.cardLabels()"
        [cardLabelIds]="state.labelIdsForCard(card().id)"
        [members]="state.members()"
        [assigneeIds]="state.assigneeIdsForCard(card().id)"
        [attachments]="state.attachmentsForCard(card().id)"
        [checklists]="state.checklistsForCard(card().id)"
        [appliedChecklistTemplateIds]="state.appliedChecklistTemplateIdsForCard(card().id)"
        [linkedNotes]="state.detailForCard(card().id)?.linkedNotes ?? []"
        (checklistCreated)="state.addChecklist(card().id, $event)"
        (close)="closed.emit()"
      />
    } @else if (failed()) {
      <div class="source-error" role="alert">
        <i class="ti ti-alert-circle"></i>
        <span>This board is no longer available.</span>
        <button type="button" class="secondary" (click)="closed.emit()">Close</button>
      </div>
    }
  `,
  styles: [`
    .source-error {
      position: fixed;
      right: 24px;
      bottom: 24px;
      z-index: 1002;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px;
      color: var(--text);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 12px 32px rgb(0 0 0 / 18%);
    }
  `],
})
export class GlobalCardDetailHostComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly offlineCache = inject(OfflineCacheService);
  private readonly sockets = inject(SocketService);
  private readonly socketBridge = inject(BoardSocketBridge);
  readonly state = inject(BoardState);

  readonly card = input.required<WorkCard>();
  readonly catalog = input.required<WorkCatalog>();
  readonly closed = output<void>();
  readonly ready = signal(false);
  readonly failed = signal(false);
  private detachRealtime: (() => void) | null = null;
  private socket: AppSocket | null = null;
  readonly cardSummary = signal(expandCardSummary({
    id: "",
    listId: "",
    boardId: "",
    title: "",
    position: "0",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } satisfies CompactCardSummary));

  async ngOnInit(): Promise<void> {
    const card = this.card();
    this.cardSummary.set(expandCardSummary(card));
    const provisionalReady = this.hydrateFromCatalog(card);
    if (provisionalReady) {
      // The global catalog already contains the common board vocabulary. Mount the same detail
      // component immediately, then replace this provisional context with the access-checked board
      // payload below. BoardState.hydrate preserves detail already loaded during that reconciliation.
      this.attachRealtime();
      this.ready.set(true);
    }
    try {
      const payload = await this.api.get<SourceBoardPayload>(`/boards/${card.boardId}?includeCards=false`);
      this.state.hydrate({
        ...payload,
        cards: [this.cardSummary()],
        separators: [],
        customFieldValuesComplete: false,
      });
      this.attachRealtime();
      this.ready.set(true);
    } catch (error) {
      const cached = await this.offlineCache.loadBoard(card.boardId).catch(() => null);
      if (cached) {
        this.state.restoreSnapshot(cached);
        if (!this.state.cardsById().has(card.id)) this.state.addCard(this.cardSummary());
        this.attachRealtime();
        this.ready.set(true);
        return;
      }
      if (provisionalReady) {
        // A network outage can still use the provisional catalog plus CardDetail's own cached
        // detail. Definite access failures close instead of leaving stale editing controls mounted.
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          this.closed.emit();
        }
        return;
      }
      this.failed.set(true);
    }
  }

  ngOnDestroy(): void {
    this.detachRealtime?.();
    if (this.socket) {
      this.socket.off("board:member:removed", this.onBoardMemberRemoved);
      this.socket.off("board:deleted", this.onBoardDeleted);
    }
  }

  private attachRealtime(): void {
    if (this.detachRealtime) return;
    const socket = this.sockets.connect();
    this.socket = socket;
    this.detachRealtime = this.socketBridge.attach(socket, this.card().boardId, {
      viewerUserId: this.auth.user()?.id ?? null,
      manageRoom: false,
      onDesync: () => {
        // The parent query owns the durable projection; closing on a detail-only desync lets that
        // projection re-open a fresh source context without retaining stale native metadata.
        this.closed.emit();
      },
    });
    socket.on("board:member:removed", this.onBoardMemberRemoved);
    socket.on("board:deleted", this.onBoardDeleted);
  }

  private hydrateFromCatalog(card: WorkCard): boolean {
    const catalog = this.catalog();
    const board = catalog.boards.find((candidate) => candidate.id === card.boardId);
    if (!board) return false;
    const workspace = catalog.workspaces.find((candidate) => candidate.id === board.workspaceId);
    if (!workspace) return false;
    const timestamp = new Date(0);
    this.state.hydrate({
      board: {
        id: board.id,
        workspaceId: board.workspaceId,
        groupId: null,
        standaloneGroupId: null,
        name: board.name,
        description: null,
        icon: board.icon,
        iconColor: board.iconColor,
        backgroundGradient: null,
        position: "0",
        archivedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      workspaceClientId: workspace.organisationId,
      workspaceKind: workspace.kind,
      lists: catalog.lists
        .filter((list) => list.workspaceId === workspace.id)
        .map((list) => ({
          ...list,
          archivedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
      cards: [this.cardSummary()],
      separators: [],
      customFields: catalog.customFields.filter((field) => field.workspaceId === workspace.id),
      cardLabels: catalog.labels
        .filter((label) => label.workspaceId === workspace.id)
        .map((label) => ({
          ...label,
          archivedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
      checklistTemplates: [],
      members: catalog.people
        .filter((person) => person.boardIds.includes(board.id))
        .map((person) => ({
          userId: person.userId,
          displayName: person.displayName,
          avatarUrl: person.avatarUrl,
          role: board.viewerRole,
          // The catalog does not expose workspace roster roles. Treat this display-only provisional
          // row as board-derived until the authoritative payload replaces it below.
          source: "board",
          clientId: person.organisationId,
        })),
      viewerRole: board.viewerRole,
      viewerSource: workspace.viewerCanAccessWorkspace ? "workspace" : "board",
      viewerCanAccessWorkspace: workspace.viewerCanAccessWorkspace,
      viewerAssignedItemsOnly: board.assignedItemsOnly,
      customFieldValuesComplete: false,
    });
    return true;
  }

  private readonly onBoardMemberRemoved = ({ boardId, userId }: { boardId: string; userId: string }) => {
    if (boardId === this.card().boardId && userId === this.auth.user()?.id) this.closed.emit();
  };

  private readonly onBoardDeleted = ({ boardId }: { boardId: string }) => {
    if (boardId === this.card().boardId) this.closed.emit();
  };
}
