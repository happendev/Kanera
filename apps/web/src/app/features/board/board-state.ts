import { Injectable, computed, inject, signal } from "@angular/core";
import type {
  CardAttachmentRow,
  WireBoardMemberUser,
  WireCard,
  WireCardChecklist,
  WireCardChecklistItem,
  WireCardDetail,
  WireCardLabel,
  WireCardSummary,
  WireCustomField,
  WireCustomFieldOption,
  WireList,
  WireSeparator,
} from "@kanera/shared/events";
import type { AssignedWorkSeparator, Board, BoardSeparator, Card, CardAssignee, CardCustomFieldValue, CardLabel, CardLabelAssignment, CustomField, List, MemberRole } from "@kanera/shared/schema";
import type { OfflineBoardSnapshot } from "../../core/offline/offline-cache.service";
import { SocketService } from "../../core/realtime/socket.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";

export type AnyList = List | WireList;
export type AnyCard = Card | WireCard | WireCardSummary;
export type AnySeparator = BoardSeparator | AssignedWorkSeparator | WireSeparator;
export type BoardLaneItem = { kind: "card"; card: AnyCard } | { kind: "separator"; separator: AnySeparator };
export type LaneItemKind = "card" | "separator";
export type LaneAnchor = { type: LaneItemKind; id: string };
export type AnyCustomField = CustomField | WireCustomField;
const EMPTY_LABELS: (CardLabel | WireCardLabel)[] = [];
const EMPTY_MEMBERS: WireBoardMemberUser[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_ATTACHMENTS: CardAttachmentRow[] = [];
const EMPTY_CHECKLISTS: WireCardChecklist[] = [];
const EMPTY_FIELD_VALUES = new Map<string, CardCustomFieldValue>();

@Injectable()
export class BoardState {
  private readonly workspaceService = inject(WorkspaceService);
  private readonly sockets = inject(SocketService);
  readonly board = signal<Board | null>(null);
  readonly lists = signal<AnyList[]>([]);
  readonly cards = signal<AnyCard[]>([]);
  readonly separators = signal<AnySeparator[]>([]);
  readonly detailedCards = signal<Map<string, WireCardDetail>>(new Map());
  // Per-card counter of realtime mutations to a card's detail-scoped state (summary, labels, assignees,
  // custom-field values, attachments, checklists). The card detail drawer snapshots this before a
  // /cards/:id/detail fetch and skips mirroring the response back via setCardDetail if it advanced
  // mid-flight — otherwise a slow (stale) detail response reverts a socket update that landed while the
  // request was in flight. Bumped only from the realtime bridge (see BoardSocketBridge), so setCardDetail
  // and local optimistic writes don't inflate it.
  private readonly cardDetailRealtimeRevisions = new Map<string, number>();
  readonly customFields = signal<AnyCustomField[]>([]);
  readonly customFieldValues = signal<CardCustomFieldValue[]>([]);
  // The board-open payload only inlines custom-field values for `showOnCard` fields. This is
  // false until the full set (for filters/List View/export) has been merged in via the
  // /boards/:id/custom-field-values endpoint. See BoardPage.ensureCustomFieldValuesLoaded.
  readonly customFieldValuesComplete = signal(true);
  // Boards whose full custom-field value set has been loaded (per-board, unlike the
  // single global customFieldValuesComplete flag). Assigned Work spans many boards, so the
  // bulk custom-fields dialog keys mixed-value accuracy off this set and fetches per board.
  private readonly fullyLoadedCfValueBoardIds = new Set<string>();
  readonly cardLabels = signal<(CardLabel | WireCardLabel)[]>([]);
  readonly cardLabelAssignments = signal<CardLabelAssignment[]>([]);
  readonly members = signal<WireBoardMemberUser[]>([]);
  readonly assignableMembers = signal<WireBoardMemberUser[]>([]);
  readonly cardAssignees = signal<CardAssignee[]>([]);
  readonly cardAttachments = signal<CardAttachmentRow[]>([]);
  readonly commentCounts = signal<Map<string, number>>(new Map());
  readonly viewerRole = signal<MemberRole | null>(null);
  readonly viewerSource = signal<"board" | "workspace" | null>(null);
  readonly viewerCanAccessWorkspace = signal(false);
  readonly expandedChecklistCardIds = signal<Set<string>>(new Set());
  readonly online = this.sockets.online;
  private readonly appliedCommentCreates = new Set<string>();
  private readonly appliedCommentDeletes = new Set<string>();
  private readonly appliedAttachmentDeletes = new Set<string>();

  // Role-based edit permission only (excludes connectivity). Used for STRUCTURAL
  // show/hide of edit affordances so an offline/online blip never mounts/unmounts
  // DOM (which is what made the card-detail modal "flash"). Actual mutations remain
  // gated by `canEdit`, which also requires the client to be online.
  readonly canEditRole = computed(() => {
    const role = this.viewerRole();
    return role !== null && role !== "observer";
  });

  readonly canEdit = computed(() => this.canEditRole() && this.sockets.displayedOnline());

  readonly visibleLists = computed(() =>
    [...this.lists()]
      .filter((l) => !l.archivedAt)
      .sort((a, b) => Number(a.position) - Number(b.position)),
  );

  // O(1) card lookup index, memoized by the signal graph: it only rebuilds when the card set
  // itself changes, so the many realtime event guards that merely check whether a card exists
  // (comments, labels, assignees, custom-field values — none of which touch `cards`) stay O(1)
  // across an event burst instead of scanning every card.
  readonly cardsById = computed(() => {
    const map = new Map<string, AnyCard>();
    for (const card of this.cards()) map.set(card.id, card);
    return map;
  });

  readonly separatorsById = computed(() => {
    const map = new Map<string, AnySeparator>();
    for (const separator of this.separators()) map.set(separator.id, separator);
    return map;
  });

  readonly labelsById = computed(() =>
    new Map(this.cardLabels().map((label) => [label.id, label])),
  );

  readonly membersById = computed(() =>
    new Map(this.members().map((member) => [member.userId, member])),
  );

  readonly customFieldsById = computed(() =>
    new Map(this.customFields().map((field) => [field.id, field])),
  );

  hasCard(cardId: string): boolean {
    return this.cardsById().has(cardId);
  }

  cardById(cardId: string): AnyCard | undefined {
    return this.cardsById().get(cardId);
  }

  private readonly visibleCardsByList = computed(() => {
    const map = new Map<string, AnyCard[]>();
    for (const card of this.cards()) {
      if (card.archivedAt) continue;
      const cards = map.get(card.listId);
      if (cards) {
        cards.push(card);
      } else {
        map.set(card.listId, [card]);
      }
    }
    for (const cards of map.values()) {
      cards.sort((a, b) => Number(a.position) - Number(b.position));
    }
    return map;
  });

  readonly labelIdsByCard = computed(() => {
    const map = new Map<string, string[]>();
    for (const assignment of this.cardLabelAssignments()) {
      const labels = map.get(assignment.cardId);
      if (labels) labels.push(assignment.labelId);
      else map.set(assignment.cardId, [assignment.labelId]);
    }
    return map;
  });

  readonly visibleSeparatorsByList = computed(() => {
    const map = new Map<string, AnySeparator[]>();
    for (const separator of this.separators()) {
      const separators = map.get(separator.listId);
      if (separators) separators.push(separator);
      else map.set(separator.listId, [separator]);
    }
    for (const separators of map.values()) {
      separators.sort((a, b) => Number(a.position) - Number(b.position));
    }
    return map;
  });

  readonly labelIdSetsByCard = computed(() => {
    const map = new Map<string, Set<string>>();
    for (const assignment of this.cardLabelAssignments()) {
      let labels = map.get(assignment.cardId);
      if (!labels) {
        labels = new Set<string>();
        map.set(assignment.cardId, labels);
      }
      labels.add(assignment.labelId);
    }
    return map;
  });

  readonly labelsByCard = computed(() => {
    const labelsById = this.labelsById();
    const map = new Map<string, (CardLabel | WireCardLabel)[]>();
    for (const assignment of this.cardLabelAssignments()) {
      const label = labelsById.get(assignment.labelId);
      if (!label) continue;
      const labels = map.get(assignment.cardId);
      if (labels) {
        labels.push(label);
      } else {
        map.set(assignment.cardId, [label]);
      }
    }
    for (const labels of map.values()) {
      labels.sort((a, b) => Number(a.position) - Number(b.position));
    }
    return map;
  });

  cardsForList(listId: string): AnyCard[] {
    return this.visibleCardsByList().get(listId) ?? [];
  }

  separatorsForList(listId: string): AnySeparator[] {
    return this.visibleSeparatorsByList().get(listId) ?? [];
  }

  itemsForList(listId: string, cards: AnyCard[] = this.cardsForList(listId), filtered = false): BoardLaneItem[] {
    const cardItems = cards.map((card): BoardLaneItem => ({ kind: "card", card }));
    const separators = this.separatorsForList(listId);
    // Unfiltered lanes show every separator, including separators on an otherwise empty list so
    // a separator a user just added stays visible.
    if (!filtered) {
      return [...cardItems, ...separators.map((separator): BoardLaneItem => ({ kind: "separator", separator }))]
        .sort((a, b) => Number(this.itemPosition(a)) - Number(this.itemPosition(b)));
    }
    // Filtered lanes keep only separators that still border a surviving card, judged against the
    // full pre-filter lane so neighbours hidden by the filter are accounted for. A list with no
    // surviving cards therefore shows no separators.
    const fullLane = this.laneItems(listId);
    const visibleIds = new Set(cards.map((card) => card.id));
    const keptSeparators = separators
      .filter((separator) => separatorBordersVisibleCard(fullLane, separator.id, visibleIds))
      .map((separator): BoardLaneItem => ({ kind: "separator", separator }));
    return [...cardItems, ...keptSeparators].sort((a, b) => Number(this.itemPosition(a)) - Number(this.itemPosition(b)));
  }

  /** Full, position-sorted lane (every card + separator in the list, ignoring any active filter). */
  laneItems(listId: string): BoardLaneItem[] {
    return [
      ...this.cardsForList(listId).map((card): BoardLaneItem => ({ kind: "card", card })),
      ...this.separatorsForList(listId).map((separator): BoardLaneItem => ({ kind: "separator", separator })),
    ].sort((a, b) => Number(this.itemPosition(a)) - Number(this.itemPosition(b)));
  }

  labelsForCard(cardId: string): (CardLabel | WireCardLabel)[] {
    return this.labelsByCard().get(cardId) ?? EMPTY_LABELS;
  }

  labelIdsForCard(cardId: string): string[] {
    return this.labelIdsByCard().get(cardId) ?? EMPTY_IDS;
  }

  setCardLabels(cardId: string, labelIds: string[]) {
    this.cardLabelAssignments.update((assignments) => [
      ...assignments.filter((assignment) => assignment.cardId !== cardId),
      ...labelIds.map((labelId) => ({ cardId, labelId, assignedAt: new Date() })),
    ]);
  }

  readonly assigneesByCard = computed(() => {
    const membersById = this.membersById();
    const map = new Map<string, WireBoardMemberUser[]>();
    for (const a of this.cardAssignees()) {
      const member = membersById.get(a.userId);
      if (!member) continue;
      const list = map.get(a.cardId);
      if (list) list.push(member);
      else map.set(a.cardId, [member]);
    }
    return map;
  });

  readonly assigneeIdsByCard = computed(() => {
    const map = new Map<string, string[]>();
    for (const a of this.cardAssignees()) {
      const list = map.get(a.cardId);
      if (list) list.push(a.userId);
      else map.set(a.cardId, [a.userId]);
    }
    return map;
  });

  readonly assigneeIdSetsByCard = computed(() => {
    const map = new Map<string, Set<string>>();
    for (const a of this.cardAssignees()) {
      let assignees = map.get(a.cardId);
      if (!assignees) {
        assignees = new Set<string>();
        map.set(a.cardId, assignees);
      }
      assignees.add(a.userId);
    }
    return map;
  });

  assigneesForCard(cardId: string): WireBoardMemberUser[] {
    return this.assigneesByCard().get(cardId) ?? EMPTY_MEMBERS;
  }

  assigneeIdsForCard(cardId: string): string[] {
    return this.assigneeIdsByCard().get(cardId) ?? EMPTY_IDS;
  }

  readonly attachmentsByCard = computed(() => {
    const map = new Map<string, CardAttachmentRow[]>();
    for (const a of this.cardAttachments()) {
      const list = map.get(a.cardId);
      if (list) list.push(a);
      else map.set(a.cardId, [a]);
    }
    for (const list of map.values()) {
      list.sort((x, y) => new Date(y.createdAt as unknown as string).getTime() - new Date(x.createdAt as unknown as string).getTime());
    }
    return map;
  });

  readonly attachmentCountByCard = computed(() => {
    // Cards with a loaded detail have their full attachment rows in cardAttachments,
    // so trust the row count there. Other cards keep the summary attachmentCount,
    // which the socket events maintain in lockstep with cardAttachments.
    const detailed = this.detailedCards();
    const rowsByCard = new Map<string, number>();
    for (const attachment of this.cardAttachments()) {
      rowsByCard.set(attachment.cardId, (rowsByCard.get(attachment.cardId) ?? 0) + 1);
    }
    const map = new Map<string, number>();
    for (const card of this.cards()) {
      if (detailed.has(card.id)) {
        map.set(card.id, rowsByCard.get(card.id) ?? 0);
      } else if ("attachmentCount" in card) {
        map.set(card.id, card.attachmentCount);
      }
    }
    return map;
  });

  readonly coverAttachmentById = computed(() =>
    new Map(this.cardAttachments().map((attachment) => [attachment.id, attachment])),
  );

  readonly coverUrlByCard = computed(() => {
    const map = new Map<string, string>();
    for (const card of this.cards()) {
      if ("coverUrl" in card && card.coverUrl) map.set(card.id, card.coverUrl);
    }
    return map;
  });

  readonly customFieldValuesByCardAndField = computed(() => {
    const map = new Map<string, Map<string, CardCustomFieldValue>>();
    for (const value of this.customFieldValues()) {
      let valuesByField = map.get(value.cardId);
      if (!valuesByField) {
        valuesByField = new Map<string, CardCustomFieldValue>();
        map.set(value.cardId, valuesByField);
      }
      valuesByField.set(value.fieldId, value);
    }
    return map;
  });

  attachmentsForCard(cardId: string): CardAttachmentRow[] {
    return this.attachmentsByCard().get(cardId) ?? EMPTY_ATTACHMENTS;
  }

  checklistsForCard(cardId: string): WireCardChecklist[] {
    return this.detailedCards().get(cardId)?.checklists ?? EMPTY_CHECKLISTS;
  }

  isCardChecklistExpanded(cardId: string): boolean {
    return this.expandedChecklistCardIds().has(cardId);
  }

  setCardChecklistExpanded(cardId: string, expanded: boolean) {
    this.expandedChecklistCardIds.update((ids) => {
      const next = new Set(ids);
      if (expanded) next.add(cardId);
      else next.delete(cardId);
      return next;
    });
  }

  appliedChecklistTemplateIdsForCard(cardId: string): string[] {
    return this.detailedCards().get(cardId)?.appliedChecklistTemplateIds ?? [];
  }

  attachmentCountForCard(cardId: string): number {
    return this.attachmentCountByCard().get(cardId) ?? 0;
  }

  commentCountForCard(cardId: string): number {
    return this.commentCounts().get(cardId) ?? 0;
  }

  coverAttachmentFor(card: AnyCard): CardAttachmentRow | null {
    const cover = (card as Card).coverAttachmentId;
    if (!cover) return null;
    return this.coverAttachmentById().get(cover) ?? null;
  }

  coverUrlForCard(card: AnyCard): string | null {
    return this.coverAttachmentFor(card)?.url ?? this.coverUrlByCard().get(card.id) ?? null;
  }

  customFieldValuesForCard(cardId: string): Map<string, CardCustomFieldValue> {
    return this.customFieldValuesByCardAndField().get(cardId) ?? EMPTY_FIELD_VALUES;
  }

  hydrate(payload: {
    board: Board;
    lists: AnyList[];
    cards: AnyCard[];
    separators?: AnySeparator[];
    customFields: AnyCustomField[];
    cardLabels: (CardLabel | WireCardLabel)[];
    members: WireBoardMemberUser[];
    viewerRole: MemberRole;
    viewerSource?: "board" | "workspace";
    viewerCanAccessWorkspace?: boolean;
    customFieldValuesComplete?: boolean;
  }) {
    this.workspaceService.registerBoards(payload.board.workspaceId, [
      { id: payload.board.id, name: payload.board.name, icon: payload.board.icon, iconColor: payload.board.iconColor },
    ]);
    this.workspaceService.cacheLists(payload.board.workspaceId, payload.lists as List[]);
    this.board.set(payload.board);
    this.lists.set(payload.lists);
    this.cards.set(payload.cards);
    this.separators.set(payload.separators ?? []);
    this.customFields.set(payload.customFields);
    // A reconnect/desync refresh re-runs hydrate while a card detail can be open. The
    // summary payload is lossy for detail-only state (it inlines only showOnCard field
    // values, carries an attachment count but no rows, etc.), so blanking that state
    // makes an open card flicker empty until /cards/:id/detail refetches — which a
    // transient re-join doesn't trigger. Keep the locally loaded detail for any card
    // still present in the payload; the per-card refetch reconciles it shortly after.
    const presentCardIds = new Set(payload.cards.map((card) => card.id));
    const retainedDetailIds = new Set(
      [...this.detailedCards().keys()].filter((id) => presentCardIds.has(id)),
    );
    // Inline values cover showOnCard fields only. For cards whose detail we retain, keep
    // the full value set loaded via setCardDetail so hidden-field values don't blank.
    const inlineCfValues = payload.cards.flatMap((card) => "customFieldValues" in card ? card.customFieldValues : []);
    const preservedCfValues = this.customFieldValues().filter((value) => retainedDetailIds.has(value.cardId));
    this.customFieldValues.set([
      ...preservedCfValues,
      ...inlineCfValues.filter((value) => !retainedDetailIds.has(value.cardId)),
    ]);
    // Older payloads (and offline snapshots) omit the flag; treat those as complete so we
    // never block on a fetch that older servers/caches can't satisfy.
    this.customFieldValuesComplete.set(payload.customFieldValuesComplete ?? true);
    this.cardLabels.set(payload.cardLabels);
    this.cardLabelAssignments.set(payload.cards.flatMap((card) =>
      "labelIds" in card ? card.labelIds.map((labelId) => ({ cardId: card.id, labelId, assignedAt: new Date() })) : [],
    ));
    this.members.set(payload.members);
    this.assignableMembers.set(payload.members);
    this.viewerRole.set(payload.viewerRole);
    this.viewerSource.set(payload.viewerSource ?? null);
    this.viewerCanAccessWorkspace.set(payload.viewerCanAccessWorkspace ?? payload.viewerSource !== "board");
    this.cardAssignees.set(payload.cards.flatMap((card) =>
      "assigneeIds" in card ? card.assigneeIds.map((userId) => ({ cardId: card.id, userId, assignedAt: new Date() })) : [],
    ));
    this.commentCounts.set(new Map(
      payload.cards
        .filter((card): card is WireCardSummary => "commentCount" in card)
        .map((card) => [card.id, card.commentCount]),
    ));
    // attachmentCountByCard trusts these rows for detailed cards, so counts stay correct.
    this.cardAttachments.update((attachments) =>
      attachments.filter((a) => retainedDetailIds.has(a.cardId)),
    );
    this.detailedCards.update((details) =>
      new Map([...details].filter(([cardId]) => presentCardIds.has(cardId))),
    );
    this.resetAppliedEventIds();
  }

  /** Replace the inline (showOnCard-only) values with the full board set once loaded. */
  setAllCustomFieldValues(values: CardCustomFieldValue[]) {
    this.customFieldValues.set(values);
    this.customFieldValuesComplete.set(true);
  }

  /**
   * Merge a batch of full value rows without dropping values for cards outside the batch.
   * Used for the per-board load on Assigned Work, where setAllCustomFieldValues would clobber
   * other boards' values.
   */
  mergeCustomFieldValues(values: CardCustomFieldValue[]) {
    if (values.length === 0) return;
    this.customFieldValues.update((current) => {
      const byKey = new Map(current.map((v) => [`${v.cardId}:${v.fieldId}`, v]));
      for (const value of values) byKey.set(`${value.cardId}:${value.fieldId}`, value);
      return [...byKey.values()];
    });
  }

  /** Upsert a single value row by its composite (cardId, fieldId) key. */
  upsertCustomFieldValue(value: CardCustomFieldValue) {
    this.customFieldValues.update((values) => {
      const exists = values.some((v) => v.cardId === value.cardId && v.fieldId === value.fieldId);
      return exists
        ? values.map((v) => (v.cardId === value.cardId && v.fieldId === value.fieldId ? value : v))
        : [...values, value];
    });
  }

  /** Remove a single value row. */
  clearCustomFieldValue(cardId: string, fieldId: string) {
    this.customFieldValues.update((values) => values.filter((v) => v.cardId !== cardId || v.fieldId !== fieldId));
  }

  markCfValuesLoadedForBoard(boardId: string) {
    this.fullyLoadedCfValueBoardIds.add(boardId);
  }

  hasFullCfValuesForBoard(boardId: string): boolean {
    return this.fullyLoadedCfValueBoardIds.has(boardId);
  }

  clear() {
    this.customFieldValuesComplete.set(true);
    this.fullyLoadedCfValueBoardIds.clear();
    this.board.set(null);
    this.lists.set([]);
    this.cards.set([]);
    this.separators.set([]);
    this.detailedCards.set(new Map());
    this.customFields.set([]);
    this.customFieldValues.set([]);
    this.cardLabels.set([]);
    this.cardLabelAssignments.set([]);
    this.members.set([]);
    this.viewerRole.set(null);
    this.viewerSource.set(null);
    this.viewerCanAccessWorkspace.set(false);
    this.cardAssignees.set([]);
    this.cardAttachments.set([]);
    this.commentCounts.set(new Map());
    this.expandedChecklistCardIds.set(new Set());
    this.resetAppliedEventIds();
  }

  setCardAssignees(cardId: string, userIds: string[]) {
    this.cardAssignees.update((as) => [
      ...as.filter((a) => a.cardId !== cardId),
      ...userIds.map((userId) => ({ cardId, userId, assignedAt: new Date() })),
    ]);
  }

  moveCard(cardId: string, listId: string, position: string) {
    // Skip echoes of a move we already applied optimistically: rebuilding the cards array
    // changes its identity and re-fires every derived computed (visibleCardsByList, etc.)
    // for no visible change. Only rebuild when the list or position actually differs.
    const current = this.cardById(cardId);
    if (current && current.listId === listId && current.position === position) return;
    this.cards.update((cs) =>
      cs.map((c) => (c.id === cardId ? { ...c, listId, position } : c)),
    );
  }

  addSeparator(separator: AnySeparator) {
    this.separators.update((separators) => (separators.some((s) => s.id === separator.id) ? separators : [...separators, separator]));
  }

  updateSeparator(separator: AnySeparator) {
    this.separators.update((separators) => separators.map((s) => (s.id === separator.id ? separator : s)));
  }

  moveSeparator(separatorId: string, listId: string, position: string) {
    const current = this.separatorsById().get(separatorId);
    if (current && current.listId === listId && current.position === position) return;
    this.separators.update((separators) =>
      separators.map((separator) => (separator.id === separatorId ? { ...separator, listId, position } : separator)),
    );
  }

  rebalanceSeparators(positions: { id: string; position: string }[]) {
    const positionsById = new Map(positions.map((p) => [p.id, p.position]));
    this.separators.update((separators) =>
      separators.map((separator) => {
        const position = positionsById.get(separator.id);
        return position ? { ...separator, position } : separator;
      }),
    );
  }

  removeSeparator(separatorId: string) {
    this.separators.update((separators) => separators.filter((separator) => separator.id !== separatorId));
  }

  rebalanceCards(positions: { id: string; position: string }[]) {
    const positionsById = new Map(positions.map((p) => [p.id, p.position]));
    this.cards.update((cs) =>
      cs.map((c) => {
        // Assigned Work listens to per-board rebalance events where hidden or
        // unassigned cards can appear in the payload; known ids update, unknown
        // ids are intentionally ignored.
        const position = positionsById.get(c.id);
        return position ? { ...c, position } : c;
      }),
    );
  }

  removeCard(cardId: string) {
    this.cards.update((cs) => cs.filter((c) => c.id !== cardId));
  }

  removeCardsForBoard(boardId: string) {
    this.cards.update((cs) => cs.filter((c) => c.boardId !== boardId));
  }

  addCard(card: AnyCard) {
    this.cards.update((cs) => (cs.some((c) => c.id === card.id) ? cs : [...cs, this.summaryFromCard(card)]));
  }

  upsertCard(card: AnyCard) {
    if (this.hasCard(card.id)) this.updateCard(card);
    else this.addCard(card);
  }

  updateCard(card: AnyCard) {
    this.cards.update((cs) => cs.map((c) => (c.id === card.id ? this.summaryFromCard(card, c) : c)));
    if (!("hasDescription" in card)) {
      this.detailedCards.update((cards) => {
        const existing = cards.get(card.id);
        if (!existing) return cards;
        const next = new Map(cards);
        next.set(card.id, { ...existing, card: card as WireCard });
        return next;
      });
    }
  }

  incrementAttachmentCount(cardId: string) {
    this.adjustAttachmentCount(cardId, 1);
  }

  decrementAttachmentCount(cardId: string) {
    this.adjustAttachmentCount(cardId, -1);
  }

  detailForCard(cardId: string): WireCardDetail | null {
    return this.detailedCards().get(cardId) ?? null;
  }

  /** Current realtime-mutation revision for a card's detail-scoped state. See cardDetailRealtimeRevisions. */
  cardDetailRealtimeRevision(cardId: string): number {
    return this.cardDetailRealtimeRevisions.get(cardId) ?? 0;
  }

  /** Record that a realtime event mutated a card's detail-scoped state. Called from BoardSocketBridge. */
  noteCardDetailRealtimeMutation(cardId: string): void {
    this.cardDetailRealtimeRevisions.set(cardId, (this.cardDetailRealtimeRevisions.get(cardId) ?? 0) + 1);
  }

  setCardDetail(detail: WireCardDetail) {
    // The detail drawer becomes the freshest source for one card. Mirror that payload
    // back into the summary collections so list tiles and the open detail stay in sync.
    this.detailedCards.update((cards) => {
      const next = new Map(cards);
      next.set(detail.card.id, detail);
      return next;
    });
    this.updateCard(detail.card);
    this.customFieldValues.update((values) => [
      ...values.filter((value) => value.cardId !== detail.card.id),
      ...detail.customFieldValues,
    ]);
    this.cardLabelAssignments.update((assignments) => [
      ...assignments.filter((assignment) => assignment.cardId !== detail.card.id),
      ...detail.labelIds.map((labelId) => ({ cardId: detail.card.id, labelId, assignedAt: new Date() })),
    ]);
    this.setCardAssignees(detail.card.id, detail.assigneeIds);
    this.cardAttachments.update((attachments) => [
      ...attachments.filter((attachment) => attachment.cardId !== detail.card.id),
      ...detail.attachments,
    ]);
  }

  addChecklist(cardId: string, checklist: WireCardChecklist) {
    const existed = this.checklistsForCard(cardId).some((c) => c.id === checklist.id);
    this.detailedCards.update((cards) => {
      const detail = cards.get(cardId);
      if (!detail) return cards;
      const next = new Map(cards);
      next.set(cardId, {
        ...detail,
        checklists: this.sortChecklists([...detail.checklists.filter((c) => c.id !== checklist.id), checklist]),
      });
      return next;
    });
    if (!existed && checklist.items.length > 0) {
      this.adjustChecklistCounts(cardId, checklist.items.filter((item) => item.completedAt).length, checklist.items.length);
    }
  }

  updateChecklist(cardId: string, checklist: WireCardChecklist) {
    this.detailedCards.update((cards) => {
      const detail = cards.get(cardId);
      if (!detail) return cards;
      const next = new Map(cards);
      next.set(cardId, {
        ...detail,
        checklists: this.sortChecklists(detail.checklists.map((c) => (c.id === checklist.id ? checklist : c))),
      });
      return next;
    });
  }

  moveChecklist(cardId: string, checklistId: string, position: string) {
    this.detailedCards.update((cards) => {
      const detail = cards.get(cardId);
      if (!detail) return cards;
      const next = new Map(cards);
      next.set(cardId, {
        ...detail,
        checklists: this.sortChecklists(detail.checklists.map((c) => (c.id === checklistId ? { ...c, position } : c))),
      });
      return next;
    });
  }

  removeChecklist(cardId: string, checklistId: string) {
    const removed = this.checklistsForCard(cardId).find((c) => c.id === checklistId);
    this.detailedCards.update((cards) => {
      const detail = cards.get(cardId);
      if (!detail) return cards;
      const next = new Map(cards);
      next.set(cardId, { ...detail, checklists: detail.checklists.filter((c) => c.id !== checklistId) });
      return next;
    });
    if (removed) this.adjustChecklistCounts(cardId, -removed.items.filter((item) => item.completedAt).length, -removed.items.length);
  }

  addChecklistItem(cardId: string, checklistId: string, item: WireCardChecklistItem) {
    this.updateChecklistItems(cardId, checklistId, (items) => this.sortChecklistItems([...items.filter((i) => i.id !== item.id), item]));
    this.adjustChecklistCounts(cardId, item.completedAt ? 1 : 0, 1);
  }

  updateChecklistItem(cardId: string, checklistId: string, item: WireCardChecklistItem, prevCompletedAt?: Date | string | null) {
    const existing = this.checklistsForCard(cardId).flatMap((c) => c.items).find((i) => i.id === item.id);
    this.updateChecklistItems(cardId, checklistId, (items) => this.sortChecklistItems(items.map((i) => (i.id === item.id ? item : i))));
    const afterDone = Boolean(item.completedAt);
    const existingDone = Boolean(existing?.completedAt);
    // Realtime echoes include the server-side previous completion value. If this
    // client already applied the same final state optimistically, using that
    // previous value again would double-adjust the card summary count.
    const beforeDone = prevCompletedAt !== undefined && (!existing || existingDone !== afterDone)
      ? Boolean(prevCompletedAt)
      : existingDone;
    if (beforeDone !== afterDone) this.adjustChecklistCounts(cardId, afterDone ? 1 : -1, 0);
  }

  moveChecklistItem(cardId: string, itemId: string, fromChecklistId: string, toChecklistId: string, position: string) {
    let moved: WireCardChecklistItem | null = null;
    this.updateChecklistItems(cardId, fromChecklistId, (items) => {
      moved = items.find((i) => i.id === itemId) ?? null;
      return items.filter((i) => i.id !== itemId);
    });
    if (!moved) return;
    const nextItem: WireCardChecklistItem = { ...(moved as WireCardChecklistItem), checklistId: toChecklistId, position };
    this.updateChecklistItems(cardId, toChecklistId, (items) => this.sortChecklistItems([...items.filter((i) => i.id !== itemId), nextItem!]));
  }

  rebalanceChecklistItems(cardId: string, checklistId: string, positions: { id: string; position: string }[]) {
    const positionsById = new Map(positions.map((p) => [p.id, p.position]));
    this.updateChecklistItems(cardId, checklistId, (items) =>
      this.sortChecklistItems(items.map((item) => {
        const position = positionsById.get(item.id);
        return position ? { ...item, position } : item;
      })),
    );
  }

  removeChecklistItem(cardId: string, checklistId: string, itemId: string, completedAt: Date | string | null) {
    this.updateChecklistItems(cardId, checklistId, (items) => items.filter((i) => i.id !== itemId));
    this.adjustChecklistCounts(cardId, completedAt ? -1 : 0, -1);
  }

  private summaryFromCard(card: AnyCard, previous?: AnyCard): AnyCard {
    if ("hasDescription" in card) return card;
    // Board columns render lightweight summaries. When a full card event arrives,
    // preserve counters and denormalized relationships from current local state.
    return {
      id: card.id,
      listId: card.listId,
      boardId: card.boardId,
      title: card.title,
      position: card.position,
      dueDateLocalDate: card.dueDateLocalDate,
      dueDateSlot: card.dueDateSlot,
      dueDateTimezone: card.dueDateTimezone,
      completedAt: card.completedAt,
      archivedAt: card.archivedAt,
      coverAttachmentId: card.coverAttachmentId,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
      hasDescription: Boolean(card.description),
      commentCount: "commentCount" in (previous ?? {}) ? (previous as WireCardSummary).commentCount : this.commentCountForCard(card.id),
      attachmentCount: "attachmentCount" in (previous ?? {}) ? (previous as WireCardSummary).attachmentCount : this.attachmentCountForCard(card.id),
      checklistDoneCount: "checklistDoneCount" in (previous ?? {}) ? (previous as WireCardSummary).checklistDoneCount : 0,
      checklistTotalCount: "checklistTotalCount" in (previous ?? {}) ? (previous as WireCardSummary).checklistTotalCount : 0,
      coverUrl: (() => {
        if (!card.coverAttachmentId) return null;
        const row = this.coverAttachmentById().get(card.coverAttachmentId);
        if (row) return row.url;
        // Only reuse the prior URL when the cover attachment hasn't changed; otherwise
        // we don't know the new URL and blank is better than a stale image.
        if (previous?.coverAttachmentId === card.coverAttachmentId) {
          return "coverUrl" in previous ? (previous as WireCardSummary).coverUrl : null;
        }
        return null;
      })(),
      labelIds: this.labelIdsForCard(card.id),
      assigneeIds: this.assigneeIdsForCard(card.id),
      customFieldValues: this.customFieldValuesForCard(card.id).size > 0
        ? [...this.customFieldValuesForCard(card.id).values()]
        : [],
    };
  }

  snapshotCards() {
    return this.cards();
  }

  restoreCards(cards: AnyCard[]) {
    this.cards.set(cards);
  }

  snapshotSeparators() {
    return this.separators();
  }

  restoreSeparators(separators: AnySeparator[]) {
    this.separators.set(separators);
  }

  snapshot(): Omit<OfflineBoardSnapshot, "boardId" | "cachedAt"> | null {
    const board = this.board();
    const viewerRole = this.viewerRole();
    if (!board || !viewerRole) return null;
    return {
      board,
      lists: this.lists(),
      workspaceLists: this.workspaceService.listsForBoard(board.id),
      cards: this.cards(),
      separators: this.separators(),
      customFields: this.customFields(),
      customFieldValues: this.customFieldValues(),
      cardLabels: this.cardLabels(),
      cardLabelAssignments: this.cardLabelAssignments(),
      members: this.members(),
      cardAssignees: this.cardAssignees(),
      cardAttachments: this.cardAttachments(),
      detailedCards: [...this.detailedCards().values()],
      commentCounts: [...this.commentCounts().entries()],
      viewerRole,
      viewerSource: this.viewerSource() ?? undefined,
      viewerCanAccessWorkspace: this.viewerCanAccessWorkspace(),
    };
  }

  restoreSnapshot(snapshot: OfflineBoardSnapshot) {
    this.workspaceService.registerBoards(snapshot.board.workspaceId, [
      { id: snapshot.board.id, name: snapshot.board.name, icon: snapshot.board.icon, iconColor: snapshot.board.iconColor },
    ]);
    this.workspaceService.cacheLists(snapshot.board.workspaceId, snapshot.workspaceLists.length ? snapshot.workspaceLists : snapshot.lists as List[]);
    this.board.set(snapshot.board);
    this.lists.set(snapshot.lists);
    this.cards.set(snapshot.cards);
    this.separators.set(snapshot.separators ?? []);
    this.customFields.set(snapshot.customFields);
    this.customFieldValues.set(snapshot.customFieldValues);
    // Offline can't fetch the rest, so treat the cached values as authoritative.
    this.customFieldValuesComplete.set(true);
    this.cardLabels.set(snapshot.cardLabels);
    this.cardLabelAssignments.set(snapshot.cardLabelAssignments);
    this.members.set(snapshot.members);
    this.assignableMembers.set(snapshot.members);
    this.viewerRole.set(snapshot.viewerRole);
    this.viewerSource.set(snapshot.viewerSource ?? null);
    this.viewerCanAccessWorkspace.set(snapshot.viewerCanAccessWorkspace ?? snapshot.viewerSource !== "board");
    this.cardAssignees.set(snapshot.cardAssignees);
    this.cardAttachments.set(snapshot.cardAttachments);
    this.detailedCards.set(new Map(snapshot.detailedCards.map((detail) => [detail.card.id, detail])));
    this.commentCounts.set(new Map(snapshot.commentCounts));
    this.resetAppliedEventIds();
  }

  positionForCardDrop(cardId: string, listId: string, beforeCardId?: string | null, afterCardId?: string | null) {
    const targetCards = this.cardsForList(listId).filter((c) => c.id !== cardId);
    const beforeIndex = beforeCardId ? targetCards.findIndex((c) => c.id === beforeCardId) : -1;
    const afterIndex = afterCardId ? targetCards.findIndex((c) => c.id === afterCardId) : -1;

    const prev =
      afterIndex >= 0
        ? targetCards[afterIndex]
        : beforeIndex > 0
          ? targetCards[beforeIndex - 1]
          : beforeCardId === null
            ? targetCards.at(-1)
            : null;
    const next =
      beforeIndex >= 0
        ? targetCards[beforeIndex]
        : afterIndex >= 0
          ? targetCards[afterIndex + 1]
          : afterCardId === null
            ? null
            : targetCards[0];

    return this.betweenPositions(prev?.position ?? null, next?.position ?? null);
  }

  positionForItemDrop(item: BoardLaneItem, listId: string, beforeItem?: BoardLaneItem | null, afterItem?: BoardLaneItem | null) {
    const targetItems = this.itemsForList(listId).filter((candidate) => this.itemKey(candidate) !== this.itemKey(item));
    const beforeIndex = beforeItem ? targetItems.findIndex((candidate) => this.itemKey(candidate) === this.itemKey(beforeItem)) : -1;
    const afterIndex = afterItem ? targetItems.findIndex((candidate) => this.itemKey(candidate) === this.itemKey(afterItem)) : -1;

    const prev =
      afterIndex >= 0
        ? targetItems[afterIndex]
        : beforeIndex > 0
          ? targetItems[beforeIndex - 1]
          : beforeItem === null
            ? targetItems.at(-1)
            : null;
    const next =
      beforeIndex >= 0
        ? targetItems[beforeIndex]
        : afterIndex >= 0
          ? targetItems[afterIndex + 1]
          : afterItem === null
            ? null
            : targetItems[0];

    return this.betweenPositions(prev ? this.itemPosition(prev) : null, next ? this.itemPosition(next) : null);
  }

  itemAnchor(item: BoardLaneItem): LaneAnchor {
    return item.kind === "card" ? { type: "card", id: item.card.id } : { type: "separator", id: item.separator.id };
  }

  itemKey(item: BoardLaneItem): string {
    const anchor = this.itemAnchor(item);
    return `${anchor.type}:${anchor.id}`;
  }

  itemPosition(item: BoardLaneItem): string {
    return item.kind === "card" ? item.card.position : item.separator.position;
  }

  private betweenPositions(prev: string | null, next: string | null) {
    if (prev === null && next === null) return "1000.0000000000";
    if (prev === null) return (Number(next) / 2).toFixed(10);
    if (next === null) return (Number(prev) + 1000).toFixed(10);
    return ((Number(prev) + Number(next)) / 2).toFixed(10);
  }

  sortCustomFields(fields: AnyCustomField[]) {
    return [...fields].sort((a, b) => Number(a.position) - Number(b.position));
  }

  /**
   * Apply a transform to a single field's embedded select options, keeping them
   * sorted by position. No-op for fields without an `options` array (older shapes).
   */
  updateFieldOptions(fieldId: string, update: (options: WireCustomFieldOption[]) => WireCustomFieldOption[]) {
    this.customFields.update((fields) =>
      fields.map((field) => {
        if (field.id !== fieldId || !("options" in field)) return field;
        const options = [...update(field.options)].sort((a, b) => Number(a.position) - Number(b.position));
        return { ...field, options };
      }),
    );
  }

  private sortChecklists(checklists: WireCardChecklist[]): WireCardChecklist[] {
    return [...checklists].sort((a, b) => Number(a.position) - Number(b.position));
  }

  private sortChecklistItems(items: WireCardChecklistItem[]): WireCardChecklistItem[] {
    return [...items].sort((a, b) => Number(a.position) - Number(b.position));
  }

  private updateChecklistItems(cardId: string, checklistId: string, update: (items: WireCardChecklistItem[]) => WireCardChecklistItem[]) {
    this.detailedCards.update((cards) => {
      const detail = cards.get(cardId);
      if (!detail) return cards;
      const next = new Map(cards);
      next.set(cardId, {
        ...detail,
        checklists: detail.checklists.map((checklist) =>
          checklist.id === checklistId ? { ...checklist, items: update(checklist.items) } : checklist,
        ),
      });
      return next;
    });
  }

  private adjustChecklistCounts(cardId: string, doneDelta: number, totalDelta: number) {
    this.cards.update((cards) =>
      cards.map((card) => {
        if (card.id !== cardId || !("checklistTotalCount" in card)) return card;
        return {
          ...card,
          checklistDoneCount: Math.max(0, card.checklistDoneCount + doneDelta),
          checklistTotalCount: Math.max(0, card.checklistTotalCount + totalDelta),
        };
      }),
    );
  }

  private adjustAttachmentCount(cardId: string, delta: number) {
    this.cards.update((cards) =>
      cards.map((card) => {
        if (card.id !== cardId || !("attachmentCount" in card)) return card;
        return { ...card, attachmentCount: Math.max(0, card.attachmentCount + delta) };
      }),
    );
  }

  // Idempotency helpers used by the socket bridge to drop duplicate event deliveries.
  // Returns true when the id is newly tracked (handler should apply the change).
  tryMarkCommentCreate(commentId: string): boolean {
    if (this.appliedCommentCreates.has(commentId)) return false;
    this.appliedCommentCreates.add(commentId);
    this.appliedCommentDeletes.delete(commentId);
    return true;
  }

  tryMarkCommentDelete(commentId: string): boolean {
    if (this.appliedCommentDeletes.has(commentId)) return false;
    this.appliedCommentDeletes.add(commentId);
    this.appliedCommentCreates.delete(commentId);
    return true;
  }

  forgetAttachmentDelete(attachmentId: string) {
    this.appliedAttachmentDeletes.delete(attachmentId);
  }

  tryMarkAttachmentDelete(attachmentId: string): boolean {
    if (this.appliedAttachmentDeletes.has(attachmentId)) return false;
    this.appliedAttachmentDeletes.add(attachmentId);
    return true;
  }

  private resetAppliedEventIds() {
    this.appliedCommentCreates.clear();
    this.appliedCommentDeletes.clear();
    this.appliedAttachmentDeletes.clear();
  }
}

/**
 * A separator only earns a row in a filtered lane when it directly borders a card that survived
 * the filter — otherwise it would float among hidden cards with no context. `laneItems` must be
 * the full, position-sorted lane (every card + separator in the list, before filtering).
 */
export function separatorBordersVisibleCard(
  laneItems: BoardLaneItem[],
  separatorId: string,
  visibleCardIds: Set<string>,
): boolean {
  const index = laneItems.findIndex((item) => item.kind === "separator" && item.separator.id === separatorId);
  if (index < 0) return false;
  const prevCard = [...laneItems.slice(0, index)].reverse().find((item) => item.kind === "card");
  const nextCard = laneItems.slice(index + 1).find((item) => item.kind === "card");
  return (
    (prevCard?.kind === "card" && visibleCardIds.has(prevCard.card.id)) ||
    (nextCard?.kind === "card" && visibleCardIds.has(nextCard.card.id))
  );
}

// Shared lane drag/drop helpers used by both the kanban list and the list-view table so card and
// separator drops resolve to the same typed anchors and committed placeholder order.
export function laneItemAnchor(item: BoardLaneItem): LaneAnchor {
  return item.kind === "card" ? { type: "card", id: item.card.id } : { type: "separator", id: item.separator.id };
}

export function laneItemKey(item: BoardLaneItem): string {
  const anchor = laneItemAnchor(item);
  return `${anchor.type}:${anchor.id}`;
}

/** Rebuild a lane with `dropped` re-inserted at the CDK `currentIndex` (item space). */
export function committedItemOrderForDrop(items: BoardLaneItem[], dropped: BoardLaneItem | undefined, currentIndex: number): BoardLaneItem[] {
  if (!dropped) return items;
  const key = laneItemKey(dropped);
  const without = items.filter((item) => laneItemKey(item) !== key);
  const insertIndex = Math.max(0, Math.min(currentIndex, without.length));
  return [...without.slice(0, insertIndex), dropped, ...without.slice(insertIndex)];
}

export function sameItemOrder(left: BoardLaneItem[], right: BoardLaneItem[]): boolean {
  return left.length === right.length && left.every((item, index) => right[index] !== undefined && laneItemKey(item) === laneItemKey(right[index]!));
}
