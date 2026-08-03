import { Injectable } from "@angular/core";
import type { HomeTodayResponse, PortfolioSummary, SavedWorkView, WorkCatalog, WorkQueryResponse, WorkViewDefinition } from "@kanera/shared/dto";
import type { CardAttachmentRow, CardFeedItem, WireBoardMemberUser, WireCard, WireCardDetail, WireCardLabel, WireCardSummary, WireChecklistTemplate, WireList, WireNote, WireSeparator } from "@kanera/shared/events";
import type {
  Board,
  BoardSeparator,
  BoardGroup,
  Card,
  CardAssignee,
  CardCustomFieldValue,
  CardLabel,
  CardLabelAssignment,
  CustomField,
  List,
  BoardRole,
  StandaloneBoardGroup,
  Workspace,
} from "@kanera/shared/schema";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export type HomeWorkspaceMember = {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  lastOnlineAt?: string | Date | null;
  role: "admin" | "member";
};

export type HomeBoardWithStats = {
  id: string;
  workspaceId: string;
  groupId: string | null;
  standaloneGroupId: string | null;
  name: string;
  icon: string | null;
  iconColor: string | null;
  backgroundGradient: string | null;
  position: string;
  /** Effective board permission returned by /home/boards. Older cached shells may omit it. */
  viewerRole?: BoardRole;
  /** Present only for downgrade-archived boards retained in the navigation directory. */
  disabledByPlan?: boolean;
  myCards: number;
  myOverdue: number;
};

export type HomeDueSoonCard = {
  // For cards, `id` is the card id. For checklist items, `id` is the item id (unique, used as
  // the track key) and `cardId` is the parent card to deep-link to (items have no own route).
  kind: "card" | "checklistItem";
  id: string;
  cardId?: string;
  cardTitle?: string;
  itemText?: string;
  boardId: string;
  workspaceId: string;
  title: string;
  boardName: string;
  boardIcon: string | null;
  dueDateLocalDate: string;
  dueDateSlot: "anyTime" | "morning" | "afternoon" | "endOfWorkDay" | null;
  dueDateTimezone: string | null;
};

export type HomeGroup = {
  workspace: Workspace & { role: string };
  boardGroups: BoardGroup[];
  boards: (Board | HomeBoardWithStats)[];
  members: HomeWorkspaceMember[];
};

export type GuestHomeGroup = {
  workspace: Workspace & { role: string };
  clientName: string;
  boardGroups: BoardGroup[];
  boards: HomeBoardWithStats[];
};

export type HomeResponse = {
  groups: HomeGroup[];
  guestGroups: GuestHomeGroup[];
  standaloneBoardGroups?: StandaloneBoardGroup[];
  dueSoon: HomeDueSoonCard[];
  // Count of overdue assigned checklist items across accessible boards. Kept separate from the
  // card-based per-board overdue stats so the UI can surface it as its own chip without
  // conflating the two entity types.
  overdueChecklistItems: number;
};

export type OfflineShellEntry = {
  groups: HomeGroup[];
  guestGroups?: GuestHomeGroup[];
  standaloneBoardGroups?: StandaloneBoardGroup[];
  cachedAt: string;
};

export type OfflineBoardSnapshot = {
  boardId: string;
  cachedAt: string;
  board: Board;
  workspaceClientId?: string | null;
  workspaceKind?: "standard" | "board";
  workspaceCardKeyPrefixes?: string[];
  boardLinkingEnabled?: boolean;
  hasMirrors?: boolean;
  lists: (List | WireList)[];
  workspaceLists: List[];
  cards: (Card | WireCard | WireCardSummary)[];
  separators?: (BoardSeparator | WireSeparator)[];
  customFields: CustomField[];
  customFieldValues: CardCustomFieldValue[];
  cardLabels: (CardLabel | WireCardLabel)[];
  checklistTemplates?: WireChecklistTemplate[];
  cardLabelAssignments: CardLabelAssignment[];
  members: WireBoardMemberUser[];
  cardAssignees: CardAssignee[];
  cardAttachments: CardAttachmentRow[];
  detailedCards: WireCardDetail[];
  commentCounts: [string, number][];
  viewerRole: BoardRole;
  viewerSource?: "board" | "workspace";
  viewerCanAccessWorkspace?: boolean;
  viewerIsWorkspaceAdmin?: boolean;
  viewerAssignedItemsOnly?: boolean;
};

export type OfflineCardDetailEntry = {
  cardId: string;
  cachedAt: string;
  detail: WireCardDetail;
  feed: CardFeedItem[];
};

export type OfflineNotesSnapshot = {
  key: string;
  cachedAt: string;
  workspaceId: string;
  boardId: string | null;
  notes: WireNote[];
};

export type OfflineGlobalWorkSnapshot = {
  key: string;
  cachedAt: string;
  definition: WorkViewDefinition;
  catalog: WorkCatalog;
  response: WorkQueryResponse;
  portfolio: PortfolioSummary | null;
  savedViews: SavedWorkView[];
};

export type OfflineHomeTodaySnapshot = {
  // Keyed by client *and user*: the agenda is personal, unlike the shell, which is per client.
  key: string;
  cachedAt: string;
  response: HomeTodayResponse;
};

interface KaneraOfflineDb extends DBSchema {
  shell: {
    key: string;
    value: OfflineShellEntry;
  };
  boards: {
    key: string;
    value: OfflineBoardSnapshot;
  };
  cardDetails: {
    key: string;
    value: OfflineCardDetailEntry;
  };
  notes: {
    key: string;
    value: OfflineNotesSnapshot;
  };
  globalWork: {
    key: string;
    value: OfflineGlobalWorkSnapshot;
  };
  homeToday: {
    key: string;
    value: OfflineHomeTodaySnapshot;
  };
}

@Injectable({ providedIn: "root" })
export class OfflineCacheService {
  private dbPromise: Promise<IDBPDatabase<KaneraOfflineDb>> | null = null;

  async saveShell(clientId: string, groups: HomeGroup[], guestGroups: GuestHomeGroup[] = [], standaloneBoardGroups: StandaloneBoardGroup[] = []): Promise<void> {
    const db = await this.db();
    await db.put("shell", { groups, guestGroups, standaloneBoardGroups, cachedAt: new Date().toISOString() }, clientId);
  }

  async loadShell(clientId: string): Promise<OfflineShellEntry | null> {
    const db = await this.db();
    return (await db.get("shell", clientId)) ?? null;
  }

  async saveBoard(boardId: string, snapshot: Omit<OfflineBoardSnapshot, "boardId" | "cachedAt">): Promise<void> {
    const db = await this.db();
    const existing = await db.get("boards", boardId);
    const cardIds = new Set(snapshot.cards.map((card) => card.id));
    const detailsByCardId = new Map(
      existing?.detailedCards
        .filter((detail) => cardIds.has(detail.card.id))
        .map((detail) => [detail.card.id, detail]) ?? [],
    );
    for (const detail of snapshot.detailedCards) {
      if (cardIds.has(detail.card.id)) detailsByCardId.set(detail.card.id, detail);
    }
    await db.put("boards", {
      ...snapshot,
      boardId,
      cachedAt: new Date().toISOString(),
      detailedCards: [...detailsByCardId.values()],
    }, boardId);
  }

  async loadBoard(boardId: string): Promise<OfflineBoardSnapshot | null> {
    const db = await this.db();
    return (await db.get("boards", boardId)) ?? null;
  }

  async revokeBoardAccess(boardId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(["shell", "boards", "cardDetails", "globalWork", "homeToday"], "readwrite");
    const shellStore = tx.objectStore("shell");
    const [shells, shellKeys] = await Promise.all([shellStore.getAll(), shellStore.getAllKeys()]);
    for (let index = 0; index < shells.length; index += 1) {
      const shell = shells[index]!;
      await shellStore.put({
        ...shell,
        groups: shell.groups.map((group) => ({
          ...group,
          boards: group.boards.filter((board) => board.id !== boardId),
        })),
        guestGroups: shell.guestGroups?.map((group) => ({
          ...group,
          boards: group.boards.filter((board) => board.id !== boardId),
        })).filter((group) => group.boards.length > 0),
      }, shellKeys[index]!);
    }
    await tx.objectStore("boards").delete(boardId);
    // Revocation must remove detail rows too; otherwise an inaccessible card can remain readable
    // from IndexedDB even after its containing board snapshot and navigation entry are gone.
    const cardDetails = await tx.objectStore("cardDetails").getAll();
    await Promise.all(cardDetails
      .filter((entry) => entry.detail.card.boardId === boardId)
      .map((entry) => tx.objectStore("cardDetails").delete(entry.cardId)));
    // A consolidated snapshot mixes multiple sources and aggregate counts. Clear it atomically on
    // any definitive revocation rather than trying to subtract one board and risk retaining its
    // metadata or leaking it indirectly through stale portfolio totals.
    await tx.objectStore("globalWork").clear();
    // Same reasoning for the home agenda: it mixes boards with aggregate counts and a completion
    // trend, so subtracting one board risks leaking it indirectly through stale totals.
    await tx.objectStore("homeToday").clear();
    await tx.done;
  }

  async saveCardDetail(cardId: string, detail: WireCardDetail, feed: CardFeedItem[]): Promise<void> {
    const db = await this.db();
    await db.put("cardDetails", { cardId, cachedAt: new Date().toISOString(), detail, feed }, cardId);
    const boardId = detail.card.boardId;
    const boardSnapshot = await db.get("boards", boardId);
    if (!boardSnapshot) return;
    await db.put("boards", {
      ...boardSnapshot,
      cachedAt: new Date().toISOString(),
      detailedCards: [
        ...boardSnapshot.detailedCards.filter((cachedDetail) => cachedDetail.card.id !== cardId),
        detail,
      ],
    }, boardId);
  }

  async loadCardDetail(cardId: string): Promise<OfflineCardDetailEntry | null> {
    const db = await this.db();
    return (await db.get("cardDetails", cardId)) ?? null;
  }

  async saveNotes(workspaceId: string, boardId: string | null, notes: WireNote[]): Promise<void> {
    const db = await this.db();
    const key = this.notesKey(workspaceId, boardId);
    await db.put("notes", { key, cachedAt: new Date().toISOString(), workspaceId, boardId, notes }, key);
  }

  async loadNotes(workspaceId: string, boardId: string | null): Promise<OfflineNotesSnapshot | null> {
    const db = await this.db();
    return (await db.get("notes", this.notesKey(workspaceId, boardId))) ?? null;
  }

  async saveGlobalWork(
    key: string,
    definition: WorkViewDefinition,
    catalog: WorkCatalog,
    response: WorkQueryResponse,
    portfolio: PortfolioSummary | null,
    savedViews: SavedWorkView[],
  ): Promise<void> {
    const db = await this.db();
    await db.put("globalWork", {
      key,
      cachedAt: new Date().toISOString(),
      definition,
      catalog,
      response,
      portfolio,
      savedViews,
    }, key);
  }

  async loadGlobalWork(key: string): Promise<OfflineGlobalWorkSnapshot | null> {
    const db = await this.db();
    const snapshot = await db.get("globalWork", key);
    if (!snapshot) return null;
    // Version-7 snapshots predate Global Work separators. Preserve their useful card/catalog data
    // while supplying the new lane fields so an offline board view never reads `undefined`.
    return {
      ...snapshot,
      response: {
        ...snapshot.response,
        separators: snapshot.response.separators ?? [],
        separatorWorkspaceIds: snapshot.response.separatorWorkspaceIds ?? [],
      },
    };
  }

  async saveHomeToday(key: string, response: HomeTodayResponse): Promise<void> {
    const db = await this.db();
    await db.put("homeToday", { key, cachedAt: new Date().toISOString(), response }, key);
  }

  async loadHomeToday(key: string): Promise<OfflineHomeTodaySnapshot | null> {
    const db = await this.db();
    return (await db.get("homeToday", key)) ?? null;
  }

  async clearAll(): Promise<void> {
    const db = await this.db();
    await Promise.all([
      db.clear("shell"),
      db.clear("boards"),
      db.clear("cardDetails"),
      db.clear("notes"),
      db.clear("globalWork"),
      db.clear("homeToday"),
    ]);
  }

  private notesKey(workspaceId: string, boardId: string | null): string {
    return `${workspaceId}:${boardId ?? "workspace"}`;
  }

  private db(): Promise<IDBPDatabase<KaneraOfflineDb>> {
    // Version 5 added `homeToday`; version 6 invalidates the older client-scoped Global Work
    // snapshots. Those projections are permission- and user-specific, so they must not survive the
    // move to client+user+lens keys even on a shared browser. Version 7 removes the cache store for
    // the retired workspace-scoped work page.
    this.dbPromise ??= openDB<KaneraOfflineDb>("kanera-offline", 7, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (!db.objectStoreNames.contains("shell")) db.createObjectStore("shell");
        if (!db.objectStoreNames.contains("boards")) db.createObjectStore("boards");
        if (!db.objectStoreNames.contains("cardDetails")) db.createObjectStore("cardDetails");
        if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes");
        if (!db.objectStoreNames.contains("globalWork")) db.createObjectStore("globalWork");
        if (!db.objectStoreNames.contains("homeToday")) db.createObjectStore("homeToday");
        if (oldVersion < 6) void transaction.objectStore("globalWork").clear();
        const legacyDb = db as unknown as { objectStoreNames: DOMStringList; deleteObjectStore(name: string): void };
        if (oldVersion < 7 && legacyDb.objectStoreNames.contains("assignedWork")) {
          legacyDb.deleteObjectStore("assignedWork");
        }
      },
    });
    return this.dbPromise;
  }
}
