import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
import type { MirrorTargetBoard } from "@kanera/shared/dto";
import type { List } from "@kanera/shared/schema";
import { ApiError } from "../../core/api/api.client";
import { BoardMirrorsService } from "./board-mirrors.service";

@Component({
  selector: "k-mirror-create-dialog",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="backdrop" (click)="dismissed.emit()">
      <section class="dialog" role="dialog" aria-modal="true" aria-label="Mirror this board" (click)="$event.stopPropagation()">
        <header>
          <div>
            <h2>Mirror this board</h2>
            <p>Create a one-way copy owned by the target board.</p>
          </div>
          <button type="button" class="ghost icon" (click)="dismissed.emit()" aria-label="Close"><i class="ti ti-x"></i></button>
        </header>
        <div class="direction-rule">
          <i class="ti ti-arrow-right"></i>
          <div><strong>One-way board mirror</strong><span>Cards are copied from this board to the target only. Once linked, the target cannot be used as a source for another mirror.</span></div>
        </div>
        @if (loading()) {
          <p class="state"><i class="ti ti-loader-2 kanera-spin"></i> Loading target boards…</p>
        } @else if (step() === 1) {
          @if (sourceBlockedByIncomingMirror()) {
            <div class="topology-error" role="alert">
              <i class="ti ti-ban"></i>
              <div><strong>This board is already a mirror target.</strong><span>A mirror target cannot also be a mirror source. Delete its incoming mirror relationship first.</span></div>
            </div>
          } @else {
            <label class="field"><span>Target board</span>
              <select [value]="targetBoardId()" [attr.aria-invalid]="error() ? 'true' : null" [attr.aria-describedby]="error() ? 'mirror-create-error' : null" (input)="chooseTarget($any($event.target).value)">
                <option value="" [selected]="!targetBoardId()">Choose a board…</option>
                @for (group of targetGroups(); track group.workspaceId) {
                  <optgroup [label]="group.organisationName + ' / ' + group.workspaceName">
                    @for (board of group.boards; track board.id) {
                      <option [value]="board.id" [selected]="board.id === targetBoardId()">{{ board.name }}</option>
                    }
                  </optgroup>
                }
              </select>
            </label>
            @if (targetGroups().length === 0) {
              <p class="state"><i class="ti ti-info-circle"></i> No eligible target boards are available.</p>
            } @else {
              <p class="eligibility-note"><i class="ti ti-shield-check"></i> Only eligible targets are shown. Existing mirror sources and boards already targeted by this board are hidden.</p>
            }
            @if (error(); as message) { <p id="mirror-create-error" class="error" role="alert"><i class="ti ti-alert-circle"></i>{{ message }}</p> }
            <footer><button type="button" class="ghost" (click)="dismissed.emit()">Cancel</button><button type="button" (click)="step.set(2)" [disabled]="!targetBoardId()">Continue <i class="ti ti-arrow-right"></i></button></footer>
          }
        } @else {
          <div class="step-copy">
            <strong>Choose source lists</strong>
            <span>Cards become linked when created in or moved into a selected list.</span>
          </div>
          <div class="list-grid" [class.has-targets]="crossWorkspace()">
            @if (crossWorkspace()) {
              <div class="list-grid-heading" aria-hidden="true"><span>Source list</span><span>Target list</span></div>
            }
            @for (list of sourceLists(); track list.id) {
              <div class="list-row">
                <label class="list-choice"><input type="checkbox" [checked]="selectedListIds().has(list.id)" (change)="toggleList(list.id, $any($event.target).checked)" /><span>{{ list.name }}</span></label>
                @if (crossWorkspace()) {
                  <div class="target-list-field">
                    <select [value]="targetListIds()[list.id]" [disabled]="!selectedListIds().has(list.id)" [attr.aria-invalid]="validationAttempted() && selectedListIds().has(list.id) && !targetListIds()[list.id] ? 'true' : null" [attr.aria-label]="'Target list for ' + list.name" (input)="setTargetList(list.id, $any($event.target).value)">
                      <option value="" [selected]="!targetListIds()[list.id]">Choose target list…</option>
                      @for (targetList of selectedTarget()?.lists ?? []; track targetList.id) {
                        <option [value]="targetList.id" [selected]="targetList.id === targetListIds()[list.id]">{{ targetList.name }}</option>
                      }
                    </select>
                    @if (validationAttempted() && selectedListIds().has(list.id) && !targetListIds()[list.id]) { <span class="field-error">Choose a target list.</span> }
                  </div>
                }
              </div>
            }
          </div>
          @if (error(); as message) { <p class="error" role="alert"><i class="ti ti-alert-circle"></i>{{ message }}</p> }
          <footer><button type="button" class="ghost" (click)="step.set(1)"><i class="ti ti-arrow-left"></i> Back</button><button type="button" (click)="create()" [disabled]="saving()">@if (saving()) { <i class="ti ti-loader-2 kanera-spin"></i> } Create mirror</button></footer>
        }
      </section>
    </div>
  `,
  styles: [`
    .backdrop { position: fixed; inset: 0; z-index: 10020; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgb(0 0 0 / 52%); }
    .dialog { width: min(560px, 100%); max-height: min(760px, 90vh); overflow: auto; background: var(--surface, #fff); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 20px 50px rgb(0 0 0 / 18%); padding: 20px; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
    h2 { margin: 0 0 4px; color: var(--text); font-size: 18px; }
    header p, .step-copy span { margin: 0; color: var(--text-muted); font-size: 13px; }
    .direction-rule, .topology-error { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 18px; padding: 11px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
    .direction-rule > i, .topology-error > i { flex: 0 0 auto; margin-top: 1px; font-size: 17px; }
    .direction-rule > i { color: var(--accent); }
    .direction-rule div, .topology-error div { display: flex; flex-direction: column; gap: 3px; }
    .direction-rule strong, .topology-error strong { color: var(--text); font-size: 13px; }
    .direction-rule span, .topology-error span { color: var(--text-muted); font-size: 12px; line-height: 1.4; }
    .topology-error { border-color: color-mix(in srgb, var(--danger) 35%, var(--border)); background: color-mix(in srgb, var(--danger) 7%, var(--surface)); }
    .topology-error > i, .topology-error strong { color: var(--danger); }
    .field { display: grid; gap: 7px; color: var(--text); font-size: 13px; font-weight: 600; }
    .step-copy { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
    .step-copy strong { color: var(--text); font-size: 14px; }
    .list-grid { display: grid; gap: 8px; }
    .list-grid-heading, .list-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(190px, 1fr); gap: 16px; align-items: center; }
    .list-grid-heading { padding: 0 12px; color: var(--text-muted); font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .list-row { min-height: 52px; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
    .list-grid:not(.has-targets) .list-row { grid-template-columns: 1fr; }
    .list-choice { display: flex; min-width: 0; align-items: center; gap: 10px; color: var(--text); font-size: 13px; font-weight: 600; cursor: pointer; }
    .list-choice input { width: 16px; height: 16px; flex: 0 0 auto; }
    .list-choice span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .list-row select:disabled { opacity: .55; }
    .target-list-field { display: grid; gap: 4px; }
    .field-error { color: var(--danger); font-size: 11px; }
    select[aria-invalid="true"] { border-color: var(--danger); outline-color: var(--danger); }
    .state { display: flex; align-items: center; gap: 8px; min-height: 44px; margin: 0; color: var(--text-muted); font-size: 13px; }
    .eligibility-note { display: flex; align-items: flex-start; gap: 6px; margin: 9px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.4; }
    .eligibility-note i { margin-top: 1px; color: var(--success, #16a34a); }
    .error { display: flex; align-items: center; gap: 6px; margin: 12px 0 0; color: var(--danger); font-size: 13px; }
    footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 22px; }
    @media (max-width: 560px) {
      .backdrop { padding: 8px; }
      .dialog { max-height: calc(100vh - 16px); }
      .list-grid-heading { display: none; }
      .list-grid-heading, .list-row { grid-template-columns: 1fr; gap: 8px; }
    }
  `],
})
export class MirrorCreateDialogComponent implements OnInit {
  private readonly mirrors = inject(BoardMirrorsService);
  readonly sourceBoardId = input.required<string>();
  readonly sourceWorkspaceId = input.required<string>();
  readonly sourceLists = input.required<List[]>();
  readonly dismissed = output<void>();
  readonly created = output<void>();
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly sourceBlockedByIncomingMirror = signal(false);
  readonly validationAttempted = signal(false);
  readonly step = signal<1 | 2>(1);
  readonly targets = signal<MirrorTargetBoard[]>([]);
  readonly targetBoardId = signal("");
  readonly selectedListIds = signal(new Set<string>());
  readonly targetListIds = signal<Record<string, string>>({});
  readonly selectedTarget = computed(() => this.targets().find((board) => board.id === this.targetBoardId()) ?? null);
  readonly crossWorkspace = computed(() => this.selectedTarget()?.workspaceId !== this.sourceWorkspaceId());
  readonly targetGroups = computed(() => {
    const groups = new Map<string, { workspaceId: string; workspaceName: string; organisationName: string; boards: MirrorTargetBoard[] }>();
    for (const board of this.targets().filter((candidate) => candidate.id !== this.sourceBoardId())) {
      const group = groups.get(board.workspaceId) ?? { workspaceId: board.workspaceId, workspaceName: board.workspaceName, organisationName: board.organisationName, boards: [] };
      group.boards.push(board);
      groups.set(board.workspaceId, group);
    }
    return [...groups.values()];
  });
  readonly canCreate = computed(() => {
    if (!this.selectedTarget()) return false;
    if (this.selectedListIds().size === 0) return false;
    return !this.crossWorkspace() || [...this.selectedListIds()].every((id) => Boolean(this.targetListIds()[id]));
  });

  async ngOnInit() {
    try { await this.loadTargets(); }
    catch { this.error.set("Target boards could not be loaded."); }
    finally { this.loading.set(false); }
  }

  private async loadTargets() {
    const response = await this.mirrors.targetBoards(this.sourceBoardId());
    this.targets.set(response.targets);
    this.sourceBlockedByIncomingMirror.set(response.sourceBlockedByIncomingMirror);
  }

  chooseTarget(boardId: string) {
    if (boardId && !this.targets().some((board) => board.id === boardId)) {
      this.targetBoardId.set("");
      this.error.set("That board is not an eligible target. Choose one of the available boards.");
      return;
    }
    this.targetBoardId.set(boardId);
    this.selectedListIds.set(new Set());
    this.targetListIds.set({});
    this.validationAttempted.set(false);
    this.error.set(null);
  }

  toggleList(sourceListId: string, checked: boolean) {
    this.selectedListIds.update((current) => {
      const next = new Set(current);
      if (checked) next.add(sourceListId); else next.delete(sourceListId);
      return next;
    });
    if (this.canCreate()) this.error.set(null);
    if (!checked || !this.crossWorkspace()) return;
    const sourceName = this.sourceLists().find((list) => list.id === sourceListId)?.name;
    const nameMatches = this.selectedTarget()?.lists.filter((list) => list.name === sourceName) ?? [];
    if (nameMatches.length === 1) this.setTargetList(sourceListId, nameMatches[0]!.id);
  }

  setTargetList(sourceListId: string, targetListId: string) {
    this.targetListIds.update((rows) => ({ ...rows, [sourceListId]: targetListId }));
    if (this.canCreate()) this.error.set(null);
  }

  async create() {
    if (this.saving()) return;
    this.validationAttempted.set(true);
    if (!this.selectedTarget()) {
      this.step.set(1);
      this.error.set("Choose an eligible target board.");
      return;
    }
    if (this.selectedListIds().size === 0) {
      this.error.set("Select at least one source list to mirror.");
      return;
    }
    if (!this.canCreate()) {
      this.error.set("Choose a target list for every selected source list.");
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.mirrors.create(this.sourceBoardId(), {
        targetBoardId: this.targetBoardId(),
        lists: [...this.selectedListIds()].map((sourceListId) => ({ sourceListId, ...(this.crossWorkspace() && { targetListId: this.targetListIds()[sourceListId] }) })),
      });
      this.created.emit();
      this.dismissed.emit();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // The topology may have changed while this dialog was open. Drop the now-stale selection
        // and refresh server-filtered targets instead of inviting the user to submit it again.
        this.step.set(1);
        this.targetBoardId.set("");
        this.selectedListIds.set(new Set());
        this.targetListIds.set({});
        this.validationAttempted.set(false);
        this.loading.set(true);
        try { await this.loadTargets(); }
        catch { /* Keep the actionable topology conflict below; reopening retries discovery. */ }
        finally { this.loading.set(false); }
        this.error.set("That target is no longer available. Reverse, chained, and duplicate board mirrors are not allowed. Choose another eligible target.");
      } else {
        this.error.set(error instanceof ApiError && error.body && typeof error.body === "object" && "message" in error.body ? String(error.body.message) : "The mirror could not be created.");
      }
    } finally { this.saving.set(false); }
  }
}
