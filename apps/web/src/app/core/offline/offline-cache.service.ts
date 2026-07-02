import { Injectable } from "@angular/core";
import type { CardAttachmentRow, CardFeedItem, WireAssignedWorkPayload, WireBoardMemberUser, WireCard, WireCardDetail, WireCardLabel, WireCardSummary, WireList, WireNote, WireSeparator } from "@kanera/shared/events";
import type {
  Board,
  AssignedWorkSeparator,
  BoardSeparator,
  BoardGroup,
  Card,
  CardAssignee,
  CardCustomFieldValue,
  CardLabel,
  CardLabelAssignment,
  CustomField,
  List,
  MemberRole,
  Workspace,
} from "@kanera/shared/schema";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export type HomeWorkspaceMember = {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  lastOnlineAt?: string | Date | null;
  role: "owner" | "admin" | "editor" | "observer";
};

export type HomeBoardWithStats = {
  id: string;
  workspaceId: string;
  groupId: string | null;
  name: string;
  icon: string | null;
  iconColor: string | null;
  backgroundGradient: string | null;
  position: string;
  visibility: "private" | "workspace";
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
  dueSoon: HomeDueSoonCard[];
  // Count of overdue assigned checklist items across accessible boards. Kept separate from the
  // card-based per-board overdue stats so the UI can surface it as its own chip without
  // conflating the two entity types.
  overdueChecklistItems: number;
};

export type OfflineShellEntry = {
  groups: HomeGroup[];
  guestGroups?: GuestHomeGroup[];
  cachedAt: string;
};

export type OfflineBoardSnapshot = {
  boardId: string;
  cachedAt: string;
  board: Board;
  lists: (List | WireList)[];
  workspaceLists: List[];
  cards: (Card | WireCard | WireCardSummary)[];
  separators?: (BoardSeparator | AssignedWorkSeparator | WireSeparator)[];
  customFields: CustomField[];
  customFieldValues: CardCustomFieldValue[];
  cardLabels: (CardLabel | WireCardLabel)[];
  cardLabelAssignments: CardLabelAssignment[];
  members: WireBoardMemberUser[];
  cardAssignees: CardAssignee[];
  cardAttachments: CardAttachmentRow[];
  detailedCards: WireCardDetail[];
  commentCounts: [string, number][];
  viewerRole: MemberRole;
  viewerSource?: "board" | "workspace";
  viewerCanAccessWorkspace?: boolean;
};

export type OfflineCardDetailEntry = {
  cardId: string;
  cachedAt: string;
  detail: WireCardDetail;
  feed: CardFeedItem[];
};

export type OfflineAssignedWorkSnapshot = {
  key: string;
  cachedAt: string;
  payload: WireAssignedWorkPayload;
  tabMembers: WireBoardMemberUser[];
};

export type OfflineNotesSnapshot = {
  key: string;
  cachedAt: string;
  workspaceId: string;
  boardId: string | null;
  notes: WireNote[];
};

interface KaneraOfflineDb extends DBSchema {
  shell: {
    key: "current";
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
  assignedWork: {
    key: string;
    value: OfflineAssignedWorkSnapshot;
  };
  notes: {
    key: string;
    value: OfflineNotesSnapshot;
  };
}

@Injectable({ providedIn: "root" })
export class OfflineCacheService {
  private dbPromise: Promise<IDBPDatabase<KaneraOfflineDb>> | null = null;

  async saveShell(groups: HomeGroup[], guestGroups: GuestHomeGroup[] = []): Promise<void> {
    const db = await this.db();
    await db.put("shell", { groups, guestGroups, cachedAt: new Date().toISOString() }, "current");
  }

  async loadShell(): Promise<OfflineShellEntry | null> {
    const db = await this.db();
    return (await db.get("shell", "current")) ?? null;
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

  async saveAssignedWork(key: string, payload: WireAssignedWorkPayload, tabMembers: WireBoardMemberUser[]): Promise<void> {
    const db = await this.db();
    await db.put("assignedWork", { key, cachedAt: new Date().toISOString(), payload, tabMembers }, key);
  }

  async loadAssignedWork(key: string): Promise<OfflineAssignedWorkSnapshot | null> {
    const db = await this.db();
    return (await db.get("assignedWork", key)) ?? null;
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

  async clearAll(): Promise<void> {
    const db = await this.db();
    await Promise.all([
      db.clear("shell"),
      db.clear("boards"),
      db.clear("cardDetails"),
      db.clear("assignedWork"),
      db.clear("notes"),
    ]);
  }

  private notesKey(workspaceId: string, boardId: string | null): string {
    return `${workspaceId}:${boardId ?? "workspace"}`;
  }

  private db(): Promise<IDBPDatabase<KaneraOfflineDb>> {
    this.dbPromise ??= openDB<KaneraOfflineDb>("kanera-offline", 3, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("shell")) db.createObjectStore("shell");
        if (!db.objectStoreNames.contains("boards")) db.createObjectStore("boards");
        if (!db.objectStoreNames.contains("cardDetails")) db.createObjectStore("cardDetails");
        if (!db.objectStoreNames.contains("assignedWork")) db.createObjectStore("assignedWork");
        if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes");
      },
    });
    return this.dbPromise;
  }
}
