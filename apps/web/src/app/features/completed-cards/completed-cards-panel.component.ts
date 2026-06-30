import type { ElementRef, OnDestroy, OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, viewChild } from "@angular/core";
import type { CompletedCardsResponse } from "@kanera/shared/dto";
import { SERVER_EVENTS, type WireAssignedBoardSummary, type WireBoardMemberUser, type WireCardLabel, type WireCardSummary, type WireCustomField, type WireList } from "@kanera/shared/events";
import type { CardCustomFieldValue, CardLabel, CustomField, List } from "@kanera/shared/schema";
import type { Cell, SheetData } from "write-excel-file/browser";
import { ApiClient } from "../../core/api/api.client";
import { visibleSignedMediaUrl } from "../../core/media/signed-media-url";
import { SocketService } from "../../core/realtime/socket.service";
import { CardComponent } from "../board/card.component";
import {
  boardExportSnapshotFromCards,
  buildBoardExportPayload,
  buildWorkbookExport,
  sanitizeExportFileName,
  timestampForFileName,
  type BoardExportColumn,
  type BoardExportPayload,
  type BoardExportSnapshot,
} from "../board/list-view/export.util";
import type { CardGroup } from "../board/list-view/list-view.types";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { DateRangePickerPopover } from "./date-range-picker.popover";

type CompletedScope = "board" | "assigned";
type CompletedCardGroup = {
  key: string;
  label: string;
  cards: WireCardSummary[];
};

@Component({
  selector: "k-completed-cards-panel",
  standalone: true,
  imports: [CardComponent, DateRangePickerPopover, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./completed-cards-panel.component.html",
  styleUrl: "./completed-cards-panel.component.scss",
})
export class CompletedCardsPanelComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiClient);
  private readonly sockets = inject(SocketService);

  readonly scope = input.required<CompletedScope>();
  readonly boardId = input<string | null>(null);
  readonly boardName = input<string | null>(null);
  readonly workspaceId = input<string | null>(null);
  readonly userId = input<string | null>(null);
  readonly lists = input<(List | WireList)[]>([]);
  readonly boards = input<WireAssignedBoardSummary[]>([]);
  readonly customFields = input<(CustomField | WireCustomField)[]>([]);
  readonly cardLabels = input<(CardLabel | WireCardLabel)[]>([]);
  readonly members = input<WireBoardMemberUser[]>([]);
  readonly allowCardDuplicate = input(true);
  readonly allowCardCopyToBoard = input(true);

  readonly dismissed = output<void>();
  readonly cardOpened = output<WireCardSummary>();

  readonly from = signal("");
  readonly to = signal("");
  readonly searchQuery = signal("");
  readonly dateRangeOpen = signal(false);
  readonly closing = signal(false);
  readonly listId = signal("");
  readonly boardFilterId = signal("");
  readonly cards = signal<WireCardSummary[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly loading = signal(false);
  readonly loadingMore = signal(false);
  readonly exporting = signal(false);
  readonly exportMenuOpen = signal(false);
  readonly error = signal<string | null>(null);
  readonly sentinel = viewChild<ElementRef<HTMLElement>>("sentinel");

  readonly title = computed(() => this.scope() === "board" ? "Completed cards" : "Completed assigned work");
  readonly canLoad = computed(() => this.scope() === "board" ? !!this.boardId() : !!this.workspaceId() && !!this.userId());
  readonly labelsById = computed(() => new Map(this.cardLabels().map((label) => [label.id, label])));
  readonly membersById = computed(() => new Map(this.members().map((member) => [member.userId, member])));
  readonly boardsById = computed(() => new Map(this.boards().map((board) => [board.id, board])));
  readonly cardGroups = computed<CompletedCardGroup[]>(() => {
    const groups = new Map<string, CompletedCardGroup>();
    for (const card of this.cards()) {
      const key = this.completedDateKey(card);
      const existing = groups.get(key);
      if (existing) {
        existing.cards.push(card);
      } else {
        groups.set(key, { key, label: this.completedGroupDateLabel(card), cards: [card] });
      }
    }
    return [...groups.values()];
  });

  private observer: IntersectionObserver | null = null;
  private detachSocket?: () => void;
  private searchReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private loadSeq = 0;

  constructor() {
    effect(() => {
      const el = this.sentinel()?.nativeElement;
      this.observer?.disconnect();
      if (!el) return;
      this.observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void this.loadMore();
      }, { rootMargin: "160px" });
      this.observer.observe(el);
    });
  }

  ngOnInit() {
    void this.reload();
    const socket = this.sockets.connect();
    const refresh = ({ boardId }: { boardId: string }) => {
      if (!this.canLoad()) return;
      if (this.scope() === "board" && boardId !== this.boardId()) return;
      if (this.scope() === "assigned" && this.boardFilterId() && boardId !== this.boardFilterId()) return;
      void this.reload();
    };
    socket.on(SERVER_EVENTS.CARD_UPDATED, refresh);
    this.detachSocket = () => {
      socket.off(SERVER_EVENTS.CARD_UPDATED, refresh);
    };
  }

  ngOnDestroy() {
    this.observer?.disconnect();
    this.detachSocket?.();
    if (this.searchReloadTimer) clearTimeout(this.searchReloadTimer);
  }

  labelsFor(card: WireCardSummary): (CardLabel | WireCardLabel)[] {
    const byId = this.labelsById();
    return card.labelIds.map((id) => byId.get(id)).filter((label): label is CardLabel | WireCardLabel => !!label);
  }

  assigneesFor(card: WireCardSummary): WireBoardMemberUser[] {
    const byId = this.membersById();
    return card.assigneeIds.map((id) => byId.get(id)).filter((member): member is WireBoardMemberUser => !!member);
  }

  coverUrlForCard(card: WireCardSummary): string | null {
    return visibleSignedMediaUrl(card.coverUrl);
  }

  customFieldValuesFor(card: WireCardSummary): Map<string, CardCustomFieldValue> {
    return new Map(card.customFieldValues.map((value) => [value.fieldId, value]));
  }

  boardSummaryFor(card: WireCardSummary): WireAssignedBoardSummary | null {
    return this.scope() === "assigned" ? this.boardsById().get(card.boardId) ?? null : null;
  }

  completedGroupCountLabel(group: CompletedCardGroup): string {
    return `${group.cards.length} completed`;
  }

  dateLabel(value: string): string {
    if (!value) return "Any date";
    const [year, month, day] = value.split("-").map(Number);
    if (!year || !month || !day) return value;
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(year, month - 1, day));
  }

  dateRangeLabel(): string {
    if (this.from() && this.to()) return `${this.dateLabel(this.from())} - ${this.dateLabel(this.to())}`;
    if (this.from()) return `From ${this.dateLabel(this.from())}`;
    if (this.to()) return `Until ${this.dateLabel(this.to())}`;
    return "Any date";
  }

  toggleDateRange(event: MouseEvent) {
    event.stopPropagation();
    this.dateRangeOpen.update((open) => !open);
  }

  toggleExportMenu(event: MouseEvent) {
    event.stopPropagation();
    if (this.exporting()) return;
    this.exportMenuOpen.update((open) => !open);
  }

  close() {
    if (this.closing()) return;
    this.closing.set(true);
    setTimeout(() => this.dismissed.emit(), 110);
  }

  applyDateRange(range: { from: string; to: string }) {
    this.from.set(range.from);
    this.to.set(range.to);
    this.dateRangeOpen.set(false);
    this.exportMenuOpen.set(false);
    void this.reload();
  }

  clearDateRange() {
    this.from.set("");
    this.to.set("");
    this.dateRangeOpen.set(false);
    this.exportMenuOpen.set(false);
    void this.reload();
  }

  setSearchQuery(value: string) {
    this.searchQuery.set(value);
    if (this.searchReloadTimer) clearTimeout(this.searchReloadTimer);
    this.searchReloadTimer = setTimeout(() => {
      this.searchReloadTimer = null;
      void this.reload();
    }, 180);
  }

  clearSearchQuery() {
    if (!this.searchQuery()) return;
    this.searchQuery.set("");
    if (this.searchReloadTimer) {
      clearTimeout(this.searchReloadTimer);
      this.searchReloadTimer = null;
    }
    void this.reload();
  }

  setListId(target: EventTarget | null) {
    this.listId.set(this.inputValue(target));
    this.exportMenuOpen.set(false);
    void this.reload();
  }

  setBoardFilterId(target: EventTarget | null) {
    this.boardFilterId.set(this.inputValue(target));
    this.exportMenuOpen.set(false);
    void this.reload();
  }

  async exportJson() {
    if (this.exporting() || !this.canLoad()) return;
    this.exporting.set(true);
    this.error.set(null);
    try {
      const payload = await this.buildCompletedExportPayload();
      this.downloadBlob(JSON.stringify(payload, null, 2), "application/json", this.exportFileName(payload, "json"));
      this.exportMenuOpen.set(false);
    } catch {
      this.error.set("Completed cards could not be exported.");
    } finally {
      this.exporting.set(false);
    }
  }

  async exportExcel() {
    if (this.exporting() || !this.canLoad()) return;
    this.exporting.set(true);
    this.error.set(null);
    try {
      const payload = await this.buildCompletedExportPayload();
      const { default: writeXlsxFile } = await import("write-excel-file/browser");
      const sheet = buildWorkbookExport(payload).sheets[0]!;
      await writeXlsxFile(styledSheetData(sheet), {
        sheet: sheet.name,
        columns: sheet.columnWidths.map((width) => ({ width })),
        stickyRowsCount: 4,
      }).toFile(this.exportFileName(payload, "xlsx"));
      this.exportMenuOpen.set(false);
    } catch {
      this.error.set("Completed cards could not be exported.");
    } finally {
      this.exporting.set(false);
    }
  }

  private inputValue(target: EventTarget | null): string {
    return target instanceof HTMLInputElement || target instanceof HTMLSelectElement ? target.value : "";
  }

  private completedDateKey(card: WireCardSummary): string {
    if (!card.completedAt) return "unknown";
    const date = new Date(card.completedAt);
    const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
    return `${value("year")}-${value("month")}-${value("day")}`;
  }

  private completedGroupDateLabel(card: WireCardSummary): string {
    if (!card.completedAt) return "Unknown date";
    return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" }).format(new Date(card.completedAt));
  }

  async reload() {
    if (!this.canLoad()) return;
    const seq = ++this.loadSeq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await this.fetchPage(null, 30);
      if (seq !== this.loadSeq) return;
      this.cards.set(page.cards);
      this.nextCursor.set(page.nextCursor);
    } catch {
      if (seq === this.loadSeq) this.error.set("Completed cards could not be loaded.");
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  async loadMore() {
    if (!this.nextCursor() || this.loading() || this.loadingMore()) return;
    const cursor = this.nextCursor();
    this.loadingMore.set(true);
    this.error.set(null);
    try {
      const page = await this.fetchPage(cursor, 30);
      this.cards.update((cards) => [...cards, ...page.cards]);
      this.nextCursor.set(page.nextCursor);
    } catch {
      this.error.set("More completed cards could not be loaded.");
    } finally {
      this.loadingMore.set(false);
    }
  }

  private fetchPage(cursor: string | null, limit: number): Promise<CompletedCardsResponse> {
    const params = this.completedQueryParams(limit, cursor);
    if (this.scope() === "board") {
      return this.api.get<CompletedCardsResponse>(`/boards/${this.boardId()}/completed?${params.toString()}`);
    }
    return this.api.get<CompletedCardsResponse>(`/workspaces/${this.workspaceId()}/assignees/${this.userId()}/completed?${params.toString()}`);
  }

  private completedQueryParams(limit: number, cursor: string | null): URLSearchParams {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (this.from()) params.set("from", new Date(`${this.from()}T00:00:00.000`).toISOString());
    if (this.to()) params.set("to", new Date(`${this.to()}T23:59:59.999`).toISOString());
    if (this.searchQuery().trim()) params.set("q", this.searchQuery().trim());
    if (this.listId()) params.set("listId", this.listId());
    if (this.scope() === "assigned" && this.boardFilterId()) params.set("boardId", this.boardFilterId());
    if (cursor) params.set("cursor", cursor);
    return params;
  }

  private async fetchAllMatchingCards(): Promise<WireCardSummary[]> {
    const cards: WireCardSummary[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.fetchPage(cursor, 100);
      cards.push(...page.cards);
      cursor = page.nextCursor;
    } while (cursor);
    return cards;
  }

  private async buildCompletedExportPayload(): Promise<BoardExportPayload> {
    const cards = await this.fetchAllMatchingCards();
    const snapshot = boardExportSnapshotFromCards(cards, this.cardLabels(), this.members());
    const columns = this.exportColumns();
    return buildBoardExportPayload({
      board: {
        id: this.scope() === "board" ? this.boardId() ?? "completed-cards" : this.workspaceId() ?? "completed-assigned-work",
        name: this.exportSourceName(),
      },
      exportedAt: new Date().toISOString(),
      groupBy: "Completed date",
      sortBy: "Completed date",
      columns,
      aggregateConfig: {},
      groups: this.exportGroupsFor(snapshot),
      lists: this.lists(),
      labelsByCard: snapshot.labelsByCard,
      assigneesByCard: snapshot.assigneesByCard,
      customFields: this.customFields(),
      members: this.members(),
      customFieldValuesByCardAndField: snapshot.customFieldValuesByCardAndField,
      commentCounts: snapshot.commentCounts,
      attachmentCountByCard: snapshot.attachmentCountByCard,
      boardSummariesById: this.scope() === "assigned" ? this.boardsById() : null,
    });
  }

  private exportColumns(): BoardExportColumn[] {
    const columns: BoardExportColumn[] = [
      { id: "status", label: "List" },
    ];
    if (this.scope() === "assigned") columns.push({ id: "board", label: "Board" });
    columns.push(
      { id: "assignees", label: "Assignees" },
      { id: "due", label: "Due date" },
      { id: "labels", label: "Labels" },
      { id: "checklist", label: "Checklist" },
      { id: "updated", label: "Updated" },
      { id: "created", label: "Created" },
      { id: "description", label: "Description" },
      ...this.customFields().map((field) => ({ id: `cf:${field.id}`, label: field.name })),
    );
    return columns;
  }

  private exportGroupsFor(snapshot: BoardExportSnapshot): CardGroup[] {
    const groups = new Map<string, CardGroup>();
    for (const card of snapshot.cards as WireCardSummary[]) {
      const key = this.completedDateKey(card);
      const existing = groups.get(key);
      if (existing) {
        existing.cards.push(card);
      } else {
        groups.set(key, {
          key,
          label: this.completedGroupDateLabel(card),
          icon: "circle-check",
          color: null,
          acceptsDrop: false,
          meta: { completed: true },
          cards: [card],
        });
      }
    }
    return [...groups.values()];
  }

  private exportSourceName(): string {
    if (this.scope() === "assigned") return "Completed assigned work";
    return this.boardName() ?? this.boards().find((board) => board.id === this.boardId())?.name ?? "Completed cards";
  }

  private exportFileName(payload: BoardExportPayload, extension: "json" | "xlsx"): string {
    const source = this.scope() === "assigned" ? "completed-assigned-work" : `completed-cards-${sanitizeExportFileName(payload.metadata.boardName)}`;
    return `${source}-${timestampForFileName(payload.metadata.exportedAt)}.${extension}`;
  }

  private downloadBlob(content: string, type: string, fileName: string) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }
}

function styledSheetData(sheet: ReturnType<typeof buildWorkbookExport>["sheets"][number]): SheetData {
  const boldRows = new Set(sheet.boldRows);
  return sheet.rows.map((row, rowIndex) =>
    row.map((value): Cell => {
      if (value === null) return null;
      return boldRows.has(rowIndex) ? { value, fontWeight: "bold" } : value;
    }),
  );
}
