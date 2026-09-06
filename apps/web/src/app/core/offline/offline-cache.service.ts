import { Injectable, signal } from "@angular/core";
import type { HomeTodayResponse, PendingBoardInvitationSummary, PortfolioSummary, SavedWorkView, WorkCatalog, WorkQueryResponse, WorkViewDefinition } from "@kanera/shared/dto";
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
import { openDB, type DBSchema, type IDBPDatabase, type StoreValue } from "idb";

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
  /** Live bearer-token invitations are never persisted in OfflineShellEntry. */
  pendingBoardInvitations?: PendingBoardInvitationSummary[];
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
  workspaceInactiveCardsDays?: number;
  workspaceBoardHealthEnabled?: boolean;
  workspaceBoardHealthOverdueEnabled?: boolean;
  workspaceBoardHealthUnassignedEnabled?: boolean;
  workspaceBoardHealthInactiveEnabled?: boolean;
  workspaceCardKeyPrefixes?: string[];
  boardLinkingEnabled?: boolean;
  boardSyncAllowed?: boolean;
  hasMirrors?: boolean;
  lists: (List | WireList)[];
  workspaceLists: List[];
  cards: (Card | WireCard | WireCardSummary)[];
  separators?: (BoardSeparator | WireSeparator)[];
  customFields: CustomField[];
  customFieldValues: CardCustomFieldValue[];
  customFieldValuesComplete?: boolean;
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
  // Deliberately no priority queue. A stale sequence reads as an instruction, and someone following
  // "do this first" from a cached order has no way to tell it is last week's. Every queue surface
  // withholds itself offline instead — see `MyPrioritiesService`.
};

export type OfflineHomeTodaySnapshot = {
  // Keyed by client *and user*: the agenda is personal, unlike the shell, which is per client.
  key: string;
  cachedAt: string;
  response: HomeTodayResponse;
};

type CacheStore = "shell" | "boards" | "cardDetails" | "notes" | "globalWork" | "homeToday";
const CACHE_STORES: CacheStore[] = ["shell", "boards", "cardDetails", "notes", "globalWork", "homeToday"];
const CACHE_BUDGET_BYTES = 32 * 1024 * 1024;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface KaneraOfflineDb extends DBSchema {
  cacheMeta: {
    key: string;
    value: { store: CacheStore; key: string; bytes: number; savedAt: number };
  };
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
    indexes: { boardId: string };
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
  private readonly failedWrites = new Set<string>();
  readonly persistenceError = signal<string | null>(null);
  private dbPromise: Promise<IDBPDatabase<KaneraOfflineDb>> | null = null;

  async saveShell(clientId: string, groups: HomeGroup[], guestGroups: GuestHomeGroup[] = [], standaloneBoardGroups: StandaloneBoardGroup[] = []): Promise<void> {
    await this.put("shell", { groups, guestGroups, standaloneBoardGroups, cachedAt: new Date().toISOString() }, clientId);
  }

  async loadShell(clientId: string): Promise<OfflineShellEntry | null> {
    const db = await this.db();
    return (await db.get("shell", clientId)) ?? null;
  }

  async saveBoard(boardId: string, snapshot: Omit<OfflineBoardSnapshot, "boardId" | "cachedAt">): Promise<void> {
    // The snapshot already owns the live details. Detail/feed writes have a separate store and
    // must never read-modify-write a whole board (which can overwrite a newer board snapshot).
    await this.put("boards", { ...snapshot, boardId, cachedAt: new Date().toISOString() }, boardId);
  }

  async loadBoard(boardId: string): Promise<OfflineBoardSnapshot | null> {
    const db = await this.db();
    const tx = db.transaction(["boards", "cardDetails"]);
    const snapshot = await tx.objectStore("boards").get(boardId);
    if (!snapshot) return null;
    const details = new Map(snapshot.detailedCards.map((detail) => [detail.card.id, detail]));
    const entries = await tx.objectStore("cardDetails").index("boardId").getAll(boardId);
    const cardIds = new Set(snapshot.cards.map((card) => card.id));
    for (const entry of entries) {
      if (cardIds.has(entry.cardId) && (!details.has(entry.cardId) || entry.cachedAt > snapshot.cachedAt)) {
        details.set(entry.cardId, entry.detail);
      }
    }
    return { ...snapshot, detailedCards: [...details.values()] };
  }

  async revokeBoardAccess(boardId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([...CACHE_STORES, "cacheMeta"], "readwrite");
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
    const notes = await tx.objectStore("notes").getAll();
    await Promise.all(notes.filter((entry) => entry.boardId === boardId).map((entry) => tx.objectStore("notes").delete(entry.key)));
    const cardDetails = await tx.objectStore("cardDetails").index("boardId").getAll(boardId);
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
    // Remove accounting for the same rows atomically, so revoked data does not consume the
    // budget and cause unrelated offline boards to be evicted prematurely.
    const metadata = tx.objectStore("cacheMeta");
    for (const row of await metadata.getAll()) {
      if (await tx.objectStore(row.store).getKey(row.key) === undefined) {
        await metadata.delete(`${row.store}:${row.key}`);
      }
    }
    await tx.done;
  }

  async saveCardDetail(cardId: string, detail: WireCardDetail, feed: CardFeedItem[]): Promise<void> {
    await this.put("cardDetails", { cardId, cachedAt: new Date().toISOString(), detail, feed }, cardId);
  }

  async loadCardDetail(cardId: string): Promise<OfflineCardDetailEntry | null> {
    const db = await this.db();
    return (await db.get("cardDetails", cardId)) ?? null;
  }

  async saveNotes(workspaceId: string, boardId: string | null, notes: WireNote[]): Promise<void> {
    const key = this.notesKey(workspaceId, boardId);
    await this.put("notes", { key, cachedAt: new Date().toISOString(), workspaceId, boardId, notes }, key);
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
    await this.put("globalWork", {
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
    await this.put("homeToday", { key, cachedAt: new Date().toISOString(), response }, key);
  }

  async loadHomeToday(key: string): Promise<OfflineHomeTodaySnapshot | null> {
    const db = await this.db();
    return (await db.get("homeToday", key)) ?? null;
  }

  async clearAll(): Promise<void> {
    this.failedWrites.clear();
    this.persistenceError.set(null);
    const db = await this.db();
    const tx = db.transaction([...CACHE_STORES, "cacheMeta"], "readwrite");
    await Promise.all([...CACHE_STORES, "cacheMeta" as const].map((store) => tx.objectStore(store).clear()));
    await tx.done;
  }

  private async put<S extends CacheStore>(store: S, value: StoreValue<KaneraOfflineDb, S>, key: string): Promise<void> {
    try {
      // A conservative UTF-16 estimate bounds stored payloads without scanning/cloning every
      // cached board. Metadata and data eviction commit together, including across browser tabs.
      const bytes = JSON.stringify(value).length * 2;
      if (bytes > CACHE_BUDGET_BYTES) throw new Error("Snapshot exceeds offline cache capacity");
      const db = await this.db();
      const write = async (budget: number) => {
        const tx = db.transaction([...CACHE_STORES, "cacheMeta"], "readwrite");
        try {
          const meta = tx.objectStore("cacheMeta");
          const id = `${store}:${key}`;
          const rows = (await meta.getAll()).sort((a, b) => a.savedAt - b.savedAt);
          let total = rows.reduce((sum, row) => sum + (row.store === store && row.key === key ? 0 : row.bytes), bytes);
          for (const row of rows) {
            if (row.store === store && row.key === key) continue;
            if (total <= budget && Date.now() - row.savedAt <= CACHE_MAX_AGE_MS) continue;
            await tx.objectStore(row.store).delete(row.key);
            await meta.delete(`${row.store}:${row.key}`);
            total -= row.bytes;
          }
          await tx.objectStore(store).put(value, key);
          await meta.put({ store, key, bytes, savedAt: Date.now() }, id);
          await tx.done;
        } catch (error) {
          try { tx.abort(); } catch { /* The browser may already have aborted on quota failure. */ }
          await tx.done.catch(() => undefined);
          throw error;
        }
      };
      try { await write(CACHE_BUDGET_BYTES); } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "QuotaExceededError") throw error;
        // The origin may share its quota with media/service-worker assets. Commit eviction first
        // so browsers can reclaim space before retrying the failed write once.
        const tx = db.transaction([...CACHE_STORES, "cacheMeta"], "readwrite");
        const rows = (await tx.objectStore("cacheMeta").getAll()).sort((a, b) => a.savedAt - b.savedAt);
        for (const row of rows.slice(0, Math.max(1, Math.ceil(rows.length / 2)))) {
          await tx.objectStore(row.store).delete(row.key);
          await tx.objectStore("cacheMeta").delete(`${row.store}:${row.key}`);
        }
        await tx.done;
        await write(CACHE_BUDGET_BYTES / 2);
      }
      this.failedWrites.delete(`${store}:${key}`);
      if (this.failedWrites.size === 0) this.persistenceError.set(null);
    } catch (error) {
      this.failedWrites.add(`${store}:${key}`);
      this.persistenceError.set("Offline copies could not be updated. Keep this tab open and free browser storage before going offline.");
      throw error;
    }
  }

  private notesKey(workspaceId: string, boardId: string | null): string {
    return `${workspaceId}:${boardId ?? "workspace"}`;
  }

  private db(): Promise<IDBPDatabase<KaneraOfflineDb>> {
    // Version 5 added `homeToday`; version 6 invalidates the older client-scoped Global Work
    // snapshots. Those projections are permission- and user-specific, so they must not survive the
    // move to client+user+lens keys even on a shared browser. Version 7 removes the cache store for
    // the retired workspace-scoped work page. Version 9 drops `homePriorities` and deletes the
    // stored queue from Global Work snapshots: priority order is never served from cache, because a
    // stale sequence reads as an instruction the reader cannot date.
    this.dbPromise ??= openDB<KaneraOfflineDb>("kanera-offline", 10, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        // Version 10 adds bounded storage accounting and an indexed card-to-board lookup.
        if (!db.objectStoreNames.contains("cacheMeta")) db.createObjectStore("cacheMeta");
        if (!db.objectStoreNames.contains("shell")) db.createObjectStore("shell");
        if (!db.objectStoreNames.contains("boards")) db.createObjectStore("boards");
        if (!db.objectStoreNames.contains("cardDetails")) db.createObjectStore("cardDetails");
        if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes");
        if (!db.objectStoreNames.contains("globalWork")) db.createObjectStore("globalWork");
        if (!db.objectStoreNames.contains("homeToday")) db.createObjectStore("homeToday");
        if (oldVersion < 10) {
          transaction.objectStore("cardDetails").createIndex("boardId", "detail.card.boardId");
          // Account for existing snapshots without invalidating useful offline data on upgrade.
          for (const store of CACHE_STORES) {
            void transaction.objectStore(store).openCursor().then(async function account(cursor): Promise<void> {
              while (cursor) {
                await transaction.objectStore("cacheMeta").put({ store, key: String(cursor.key), bytes: JSON.stringify(cursor.value).length * 2, savedAt: Date.parse(cursor.value.cachedAt) || 0 }, `${store}:${cursor.key}`);
                cursor = await cursor.continue();
              }
            });
          }
        }
        if (oldVersion < 6) void transaction.objectStore("globalWork").clear();
        const legacyDb = db as unknown as { objectStoreNames: DOMStringList; deleteObjectStore(name: string): void };
        if (oldVersion < 7 && legacyDb.objectStoreNames.contains("assignedWork")) {
          legacyDb.deleteObjectStore("assignedWork");
        }
        // Delete rather than leave orphaned: the store holds a person's ordered work, and an
        // abandoned copy of it is exactly the durable stale sequence this change exists to remove.
        if (oldVersion < 9 && legacyDb.objectStoreNames.contains("homePriorities")) {
          legacyDb.deleteObjectStore("homePriorities");
        }
        // Existing Global Work snapshots still carry a `priorities` blob the code no longer reads.
        // Clearing the store is the cheap way to be sure none of it can be resurrected.
        if (oldVersion < 9 && db.objectStoreNames.contains("globalWork")) {
          void transaction.objectStore("globalWork").clear();
        }
      },
    }).catch((error: unknown) => {
      this.dbPromise = null;
      throw error;
    });
    return this.dbPromise;
  }
}
