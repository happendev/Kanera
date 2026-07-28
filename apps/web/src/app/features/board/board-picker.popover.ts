import type { AfterViewInit } from "@angular/core";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import type { BoardTransferTarget } from "@kanera/shared/dto";
import type { WireBoard, WireList } from "@kanera/shared/events";
import { ApiClient } from "../../core/api/api.client";
import { ANCHORED_PANEL_STYLES, ANCHORED_SHEET_STYLES, type AnchoredPanelPlacement } from "../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { PickerListComponent, type PickerGroup } from "../../shared/picker-list.component";

export type BoardPickerPick = { boardId: string; listId?: string };
type SourceListOption = Pick<WireList, "id" | "name">;

@Component({
  selector: "k-board-picker",
  standalone: true,
  imports: [PickerListComponent],
  hostDirectives: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ap-panel">
      <div class="ap-head">
        @if (phase() === 'lists') {
          <button type="button" class="ap-icon-button" (click)="backToBoards($event)" aria-label="Back to boards">
            <i class="ti ti-arrow-left"></i>
          </button>
        }
        <span class="ap-title">{{ phase() === 'boards' ? title() : 'Choose a list' }}</span>
        <button type="button" class="ap-icon-button" aria-label="Close" (click)="close.emit()">
          <i class="ti ti-x"></i>
        </button>
      </div>
      @if (loading()) {
        <p class="bp-empty">Loading…</p>
      } @else if (phase() === 'boards') {
        <k-picker-list
          [groups]="boardPickerGroups()"
          searchPlaceholder="Search boards…"
          emptyLabel="No other boards"
          (pick)="selectBoardId($event)"
        />
      } @else {
        <k-picker-list
          [groups]="listPickerGroups()"
          searchPlaceholder="Search lists…"
          emptyLabel="No lists"
          (pick)="selectList($event)"
        />
      }
    </div>
  `,
  styles: [
    ANCHORED_PANEL_STYLES,
    ANCHORED_SHEET_STYLES,
    `
    k-picker-list { min-height: 0; }

    .bp-empty {
      color: var(--text-muted);
      font-size: 12px;
      margin: 0;
      padding: 8px 4px;
      text-align: center;
    }
  `,
  ],
})
export class BoardPickerPopover implements AfterViewInit {
  private readonly panel = inject(AnchoredPanelDirective);
  private readonly api = inject(ApiClient);

  readonly sourceBoardId = input.required<string>();
  readonly excludeBoardId = input.required<string>();
  readonly allowCrossWorkspace = input(false);
  readonly sourceWorkspaceId = input<string | null>(null);
  readonly sourceListId = input<string | null>(null);
  readonly sourceListName = input<string | null>(null);
  readonly sourceLists = input<SourceListOption[]>([]);
  readonly title = input<string>("Pick a board");
  readonly panelPlacement = input<AnchoredPanelPlacement | null>(null);
  readonly pick = output<BoardPickerPick>();
  readonly close = output<void>();

  readonly loading = signal(true);
  readonly boards = signal<BoardTransferTarget[]>([]);
  readonly lists = signal<WireList[]>([]);
  readonly phase = signal<"boards" | "lists">("boards");
  private selectedBoardId: string | null = null;

  constructor() {
    this.panel.configure({
      placement: () => this.panelPlacement() ?? { align: "end", width: 280, maxHeight: 340 },
      onDismiss: () => this.close.emit(),
    });
  }

  readonly boardPickerGroups = computed<PickerGroup[]>(() => {
    const targets = this.boards().filter((board) => board.id !== this.excludeBoardId());
    const multiOrganisation = new Set(targets.map((board) => board.organisationId)).size > 1;
    const groups = new Map<string, PickerGroup>();

    for (const board of targets) {
      const organisationName = board.organisationExternal
        ? `${board.organisationName} · Guest`
        : board.organisationName;
      const standaloneGroup = board.workspaceKind === "board";
      const groupId = standaloneGroup
        ? `standalone:${board.organisationId}:${board.standaloneGroupId ?? "ungrouped"}`
        : `workspace:${board.workspaceId}`;
      let group = groups.get(groupId);
      if (!group) {
        const containerName = standaloneGroup
          ? board.standaloneGroupTitle ?? organisationName
          : board.workspaceName;
        group = {
          id: groupId,
          label: multiOrganisation && containerName !== organisationName
            ? `${organisationName} · ${containerName}`
            : containerName,
          icon: standaloneGroup ? (board.standaloneGroupTitle ? "folder" : "building") : board.workspaceIcon || "rocket",
          color: standaloneGroup ? null : board.workspaceAccentColor,
          options: [],
        };
        groups.set(groupId, group);
      }
      group.options.push({
        id: board.id,
        label: board.name,
        icon: board.icon || "layout-kanban",
        color: board.iconColor,
      });
    }

    // The endpoint already returns the sidebar's canonical navigation order. Map insertion and
    // option append order deliberately preserve it; do not alphabetize again in the picker.
    return [...groups.values()];
  });

  readonly listPickerGroups = computed<PickerGroup[]>(() => [{
    id: "lists",
    options: [...this.lists()]
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map((list) => ({
        id: list.id,
        label: list.name,
        icon: list.icon || "list",
        color: list.color,
      })),
  }]);

  ngAfterViewInit() {
    void this.load();
  }

  private async load() {
    try {
      const suffix = this.allowCrossWorkspace() ? "?crossWorkspace=1" : "";
      const boards = await this.api.get<BoardTransferTarget[]>(`/boards/${this.sourceBoardId()}/transfer-targets${suffix}`);
      this.boards.set(boards);
    } finally {
      this.loading.set(false);
      queueMicrotask(() => this.panel.reposition());
    }
  }

  selectBoardId(boardId: string) {
    const board = this.boards().find((candidate) => candidate.id === boardId);
    if (board) void this.selectBoard(board);
  }

  async selectBoard(board: Pick<WireBoard, "id" | "workspaceId">) {
    const isCrossWorkspace = this.allowCrossWorkspace()
      && Boolean(this.sourceWorkspaceId())
      && board.workspaceId !== this.sourceWorkspaceId();
    if (!isCrossWorkspace) {
      this.pick.emit({ boardId: board.id });
      return;
    }

    this.loading.set(true);
    try {
      const targetLists = await this.api.get<WireList[]>(`/boards/${board.id}/lists`);
      this.lists.set(targetLists);
      const sourceListName = this.resolvedSourceListName();
      if (sourceListName) {
        const matchingLists = targetLists.filter((list) => list.name === sourceListName);
        if (matchingLists.length === 1) {
          // Cross-workspace copies need a target list id. When the lane name maps cleanly,
          // skip the extra prompt and preserve the user's current workflow stage.
          this.pick.emit({ boardId: board.id, listId: matchingLists[0]!.id });
          return;
        }
      }
      this.selectedBoardId = board.id;
      this.phase.set("lists");
    } finally {
      this.loading.set(false);
      queueMicrotask(() => this.panel.reposition());
    }
  }

  selectList(listId: string) {
    if (!this.selectedBoardId) return;
    this.pick.emit({ boardId: this.selectedBoardId, listId });
  }

  backToBoards(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.selectedBoardId = null;
    this.phase.set("boards");
    this.loading.set(false);
    queueMicrotask(() => this.panel.reposition());
  }

  private resolvedSourceListName(): string | null {
    const direct = this.sourceListName()?.trim();
    if (direct) return direct;
    const sourceListId = this.sourceListId();
    if (!sourceListId) return null;
    return this.sourceLists().find((list) => list.id === sourceListId)?.name ?? null;
  }

}
