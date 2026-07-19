import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, HostListener, inject, signal, untracked } from "@angular/core";
import type { Board, StandaloneBoardGroup } from "@kanera/shared/schema";
import { ApiClient } from "../../../core/api/api.client";
import { ColorPickerComponent } from "../../../shared/color-picker.component";
import { IconPickerComponent } from "../../../shared/icon-picker.component";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

@Component({
  selector: "k-workspace-settings-general",
  standalone: true,
  imports: [IconPickerComponent, ColorPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./general.page.html",
  styleUrl: "./general.page.scss",
})
export class WorkspaceSettingsGeneralPage {
  protected readonly settings = inject(WorkspaceSettingsPage);
  private readonly api = inject(ApiClient);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private loadedBoardId: string | null = null;
  readonly standaloneGroups = signal<StandaloneBoardGroup[]>([]);
  readonly standaloneGroupTitle = signal("");
  private standaloneGroupSavedTitle = "";
  readonly standaloneGroupSaving = signal(false);
  readonly standaloneGroupError = signal<string | null>(null);
  readonly standaloneGroupMenuOpen = signal(false);
  readonly standaloneGroupActiveIndex = signal(-1);
  readonly standaloneGroupChoices = computed(() => {
    const query = this.standaloneGroupTitle().trim();
    const normalizedQuery = query.toLocaleLowerCase();
    const groups = this.standaloneGroups()
      .filter((group) => !normalizedQuery || group.title.toLocaleLowerCase().includes(normalizedQuery))
      .map((group) => ({ key: group.id, title: group.title, kind: "existing" as const }));

    if (!query || this.standaloneGroups().some((group) => group.title.toLocaleLowerCase() === normalizedQuery)) return groups;
    return [...groups, { key: "create", title: query, kind: "create" as const }];
  });

  constructor() {
    this.settings.selectedTab.set("general");
    effect(() => {
      const boardId = this.settings.boardId();
      if (!this.settings.isStandalone() || !boardId || boardId === this.loadedBoardId) return;
      this.loadedBoardId = boardId;
      untracked(() => void this.loadStandaloneGrouping(boardId));
    });
  }

  private async loadStandaloneGrouping(boardId: string) {
    this.standaloneGroupError.set(null);
    try {
      const [groups, board] = await Promise.all([
        this.api.get<StandaloneBoardGroup[]>("/clients/me/standalone-board-groups"),
        this.api.get<Pick<Board, "standaloneGroupId">>(`/boards/${boardId}`),
      ]);
      this.standaloneGroups.set([...groups].sort((a, b) => a.title.localeCompare(b.title)));
      const title = groups.find((group) => group.id === board.standaloneGroupId)?.title ?? "";
      this.standaloneGroupTitle.set(title);
      this.standaloneGroupSavedTitle = title;
    } catch (error) {
      this.standaloneGroupError.set(error instanceof Error ? error.message : "Could not load board group");
    }
  }

  async updateStandaloneGroup() {
    const boardId = this.settings.boardId();
    if (!boardId || this.standaloneGroupSaving()) return;
    const title = this.standaloneGroupTitle().trim();
    if (title.toLocaleLowerCase() === this.standaloneGroupSavedTitle.toLocaleLowerCase()) {
      this.standaloneGroupTitle.set(this.standaloneGroupSavedTitle);
      return;
    }
    const previous = this.standaloneGroupSavedTitle;
    this.standaloneGroupTitle.set(title);
    this.standaloneGroupSaving.set(true);
    this.standaloneGroupError.set(null);
    try {
      await this.api.patch(`/clients/me/standalone-boards/${boardId}/group`, { groupTitle: title || null });
      this.standaloneGroupSavedTitle = title;
    } catch (error) {
      this.standaloneGroupTitle.set(previous);
      this.standaloneGroupError.set(error instanceof Error ? error.message : "Could not update board group");
    } finally {
      this.standaloneGroupSaving.set(false);
    }
  }

  openStandaloneGroupMenu() {
    if (this.standaloneGroupSaving()) return;
    this.standaloneGroupMenuOpen.set(true);
    this.standaloneGroupActiveIndex.set(-1);
  }

  onStandaloneGroupInput(value: string) {
    this.standaloneGroupTitle.set(value);
    this.standaloneGroupMenuOpen.set(true);
    this.standaloneGroupActiveIndex.set(-1);
  }

  onStandaloneGroupFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    // Moving focus into an option is still part of the composite control; only leaving it commits
    // free-typed text and closes the menu.
    if (next instanceof Node && (event.currentTarget as HTMLElement).contains(next)) return;
    this.standaloneGroupMenuOpen.set(false);
    void this.updateStandaloneGroup();
  }

  @HostListener("document:mousedown", ["$event"])
  onDocumentMouseDown(event: MouseEvent) {
    const target = event.target;
    if (!this.standaloneGroupMenuOpen() || !(target instanceof Node) || this.elementRef.nativeElement.contains(target)) return;
    // A click on non-focusable page chrome does not move focus, so focusout alone cannot reliably
    // close this composite control or commit its free-typed value.
    this.standaloneGroupMenuOpen.set(false);
    void this.updateStandaloneGroup();
  }

  onStandaloneGroupKeydown(event: KeyboardEvent) {
    const choices = this.standaloneGroupChoices();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!this.standaloneGroupMenuOpen()) this.standaloneGroupMenuOpen.set(true);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const current = this.standaloneGroupActiveIndex();
      const next = current < 0
        ? (direction > 0 ? 0 : choices.length - 1)
        : (current + direction + choices.length) % choices.length;
      this.standaloneGroupActiveIndex.set(next);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const choice = choices[this.standaloneGroupActiveIndex()];
      if (this.standaloneGroupMenuOpen() && choice) void this.selectStandaloneGroup(choice.title);
      else {
        this.standaloneGroupMenuOpen.set(false);
        void this.updateStandaloneGroup();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.standaloneGroupTitle.set(this.standaloneGroupSavedTitle);
      this.standaloneGroupMenuOpen.set(false);
      this.standaloneGroupActiveIndex.set(-1);
    }
  }

  async selectStandaloneGroup(title: string) {
    this.standaloneGroupTitle.set(title);
    this.standaloneGroupMenuOpen.set(false);
    this.standaloneGroupActiveIndex.set(-1);
    await this.updateStandaloneGroup();
  }

  clearStandaloneGroup() {
    void this.selectStandaloneGroup("");
  }
}
