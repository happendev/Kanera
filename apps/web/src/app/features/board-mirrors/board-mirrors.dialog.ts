import { CdkTrapFocus } from "@angular/cdk/a11y";
import type { OnInit } from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from "@angular/core";
import type { BoardMirrorRow } from "@kanera/shared/dto";
import { ApiError } from "../../core/api/api.client";
import { BoardMirrorsService } from "./board-mirrors.service";
import { formatDateTime } from "../../shared/date-format";

// Board mirror status badges.
const MIRROR_STATUS = {
  proRequired: $localize`:Board mirror status badge:Pro required`,
  disabledBySource: $localize`:Board mirror status badge:Disabled by source`,
  paused: $localize`:Board mirror status badge:Paused`,
  pausedByTarget: $localize`:Board mirror status badge:Paused by target`,
  needsAttention: $localize`:Board mirror status badge:Needs attention`,
  active: $localize`:Board mirror status badge:Active`,
};

@Component({
  selector: "k-board-mirrors-dialog",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkTrapFocus, NgTemplateOutlet],
  template: `
    <!-- Inbound and outbound mirrors share the list-mapping editor and the action row; only the
         delete button's wording differs, so both sections stamp this template. -->
    <ng-template #mirrorEditor let-mirror let-deleteLabel="deleteLabel">
      @if (editingId() === mirror.id) {
        <div class="mapping-editor">
          <div class="mapping-copy">
            <strong i18n="Board mirror list-mapping editor heading">Choose source lists</strong>
            <span i18n>Cards become linked when created in or moved into a selected list.</span>
          </div>
          <div class="mapping-grid" [class.has-targets]="mirror.sourceWorkspaceId !== mirror.targetWorkspaceId">
            @if (mirror.sourceWorkspaceId !== mirror.targetWorkspaceId) {
              <div class="mapping-grid-heading" aria-hidden="true"><span i18n="Column heading: list on the source board of a mirror">Source list</span><span i18n="Column heading: list on the target board of a mirror">Target list</span></div>
            }
            @for (sourceList of mirror.availableSourceLists; track sourceList.id) {
              <div class="mapping-row">
                <label class="mapping-choice"><input type="checkbox" [checked]="editSelected().has(sourceList.id)" (change)="toggleEditSource(sourceList.id, $any($event.target).checked, mirror)" /><span>{{ sourceList.name }}</span></label>
              @if (mirror.sourceWorkspaceId !== mirror.targetWorkspaceId) {
                <select [value]="editTargets()[sourceList.id]" [disabled]="!editSelected().has(sourceList.id)" [attr.aria-label]="targetListLabel(sourceList.name)" (input)="setEditTarget(sourceList.id, $any($event.target).value)">
                  <option value="" [selected]="!editTargets()[sourceList.id]" i18n="Select placeholder: pick a target list">Choose target…</option>
                  @for (targetList of mirror.availableTargetLists; track targetList.id) { <option [value]="targetList.id" [selected]="targetList.id === editTargets()[sourceList.id]">{{ targetList.name }}</option> }
                </select>
              }
              </div>
            }
          </div>
          <div class="edit-actions"><button type="button" class="ghost" (click)="editingId.set(null)" i18n="Button: discard list mapping edits">Cancel</button><button type="button" (click)="saveLists(mirror)" [disabled]="busyId() || !canSaveLists(mirror)" i18n="Button: save the board mirror list mapping">Save lists</button></div>
        </div>
      }
      <div class="actions">
        @if (mirror.manageTarget) {
        <button type="button" class="secondary sm state-action" [class.is-restorative]="!!mirror.pausedAt" (click)="togglePause(mirror)" [disabled]="busyId() === mirror.id || (!!mirror.pausedAt && mirror.planBlocked)">
          <i [class]="mirror.pausedAt ? 'ti ti-player-play' : 'ti ti-player-pause'"></i>
          @if (mirror.pausedAt) { <ng-container i18n="Button: resume a paused board mirror">Resume syncing</ng-container> } @else { <ng-container i18n="Button: pause a board mirror">Pause syncing</ng-container> }
        </button>
        }
        @if (mirror.manageSource) {
        <button type="button" class="secondary sm state-action" [class.is-restorative]="!!mirror.sourceDisabledAt" (click)="toggleSource(mirror)" [disabled]="busyId() === mirror.id || (!!mirror.sourceDisabledAt && mirror.planBlocked)">
          <i [class]="mirror.sourceDisabledAt ? 'ti ti-link' : 'ti ti-link-off'"></i>
          @if (mirror.sourceDisabledAt) { <ng-container i18n="Button: re-enable a board mirror from the source side">Enable mirror</ng-container> } @else { <ng-container i18n="Button: disable a board mirror from the source side">Disable mirror</ng-container> }
        </button>
        }
        @if (mirror.manageSource || mirror.manageTarget) {
        <button type="button" class="ghost" (click)="editLists(mirror)"><i class="ti ti-list-check"></i><ng-container i18n="Button: edit which lists a board mirror copies">Edit lists</ng-container></button>
        @if (confirmDeleteId() === mirror.id) { <button type="button" class="danger" (click)="remove(mirror)" i18n="Button: confirm deleting a board mirror">Confirm delete</button><button type="button" class="ghost" (click)="confirmDeleteId.set(null)" i18n="Button: keep the board mirror">Cancel</button> }
        @else { <button type="button" class="ghost danger-text" (click)="confirmDeleteId.set(mirror.id)"><i class="ti ti-trash"></i>{{ deleteLabel }}</button> }
        } @else {
          <span class="read-only"><i class="ti ti-lock"></i> <ng-container i18n="Shown instead of actions when the viewer cannot manage a board mirror">Read-only mirror status</ng-container></span>
        }
      </div>
    </ng-template>

    <div class="backdrop" (click)="dismissed.emit()">
      <section class="dialog" role="dialog" cdkTrapFocus [cdkTrapFocusAutoCapture]="true" aria-modal="true" aria-label="Board mirrors" i18n-aria-label="Dialog name" (click)="$event.stopPropagation()">
        <header><div><h2 i18n="Dialog heading">Board mirrors</h2><p i18n>Manage incoming copies and outbound governance.</p></div><button type="button" class="icon" (click)="dismissed.emit()" aria-label="Close" i18n-aria-label="Button: close the dialog"><i class="ti ti-x"></i></button></header>
        @if (loading()) { <p class="loading"><i class="ti ti-loader-2 kanera-spin"></i> <ng-container i18n>Loading mirrors…</ng-container></p> }
        @else {
          @if (inbound().length > 0 && outbound().length > 0) {
            <div class="topology-banner danger" role="alert"><i class="ti ti-alert-triangle"></i><div><strong i18n>Invalid mirror direction detected</strong><span i18n>This board is configured as both a mirror source and a mirror target. Delete one side before re-enabling any mirror.</span></div></div>
          } @else if (inbound().length > 0) {
            <div class="topology-banner"><i class="ti ti-arrow-bar-to-down"></i><div><strong i18n>This board is a mirror target</strong><span i18n>It cannot also be used as a mirror source while an incoming relationship exists, even when paused or disabled.</span></div></div>
          } @else if (outbound().length > 0) {
            <div class="topology-banner"><i class="ti ti-arrow-bar-up"></i><div><strong i18n>This board is a mirror source</strong><span i18n>Cards are copied to its target boards only. It cannot be selected as a mirror target while an outbound relationship exists.</span></div></div>
          }
          <div class="section"><h3><ng-container i18n="Section heading: mirrors copying cards into this board">Inbound</ng-container> <span><ng-container i18n="Mirror direction diagram: source side, shown as Other boards → this board">Other boards</ng-container> <i class="ti ti-arrow-right"></i> <ng-container i18n="Mirror direction diagram: target side, shown as Other boards → this board">this board</ng-container></span></h3>
            @for (mirror of inbound(); track mirror.id) {
              <article class="mirror-card">
                <div class="mirror-title"><div><strong>{{ mirror.sourceBoardName }}</strong><span>{{ mirror.sourceOrganisationName }} / {{ mirror.sourceWorkspaceName }}</span></div><span class="status" [class.warn]="mirror.planBlocked || !!mirror.sourceDisabledAt || !!mirror.lastError">{{ statusLabel(mirror) }}</span></div>
                <p class="sync-line">{{ syncLine(mirror) }}</p>
                @if (mirror.planBlocked) { <p class="warning"><i class="ti ti-lock"></i> <ng-container i18n>Syncing is paused until both organisations have Pro.</ng-container></p> }
                @if (hasArchivedTarget(mirror)) { <p class="warning"><i class="ti ti-alert-triangle"></i> <ng-container i18n>A mapped target list is archived. Card moves into it are being skipped.</ng-container></p> }
                <div class="chips">@for (list of mirror.lists; track list.sourceListId) { <span>{{ list.sourceListName }} <i class="ti ti-arrow-right"></i> {{ list.targetListName }}</span> }</div>
                <ng-container *ngTemplateOutlet="mirrorEditor; context: { $implicit: mirror, deleteLabel: deleteLabel }" />
              </article>
            } @empty { <p class="empty" i18n>No boards mirror into this board.</p> }
          </div>
          <div class="section"><h3><ng-container i18n="Section heading: mirrors copying cards out of this board">Outbound</ng-container> <span><ng-container i18n="Mirror direction diagram: source side, shown as This board → other boards">This board</ng-container> <i class="ti ti-arrow-right"></i> <ng-container i18n="Mirror direction diagram: target side, shown as This board → other boards">other boards</ng-container></span></h3>
            @for (mirror of outbound(); track mirror.id) {
              <article class="mirror-card compact"><div class="mirror-title"><div><strong>{{ mirror.targetBoardName }}</strong><span>{{ mirror.targetOrganisationName }}</span></div><span class="status" [class.warn]="mirror.planBlocked">{{ outboundStatusLabel(mirror) }}</span></div>
                @if (mirror.planBlocked) { <p class="warning"><i class="ti ti-lock"></i> <ng-container i18n>Syncing is paused until both organisations have Pro.</ng-container></p> }
                @if (hasArchivedTarget(mirror)) { <p class="warning"><i class="ti ti-alert-triangle"></i> <ng-container i18n>A mapped target list is archived. Card moves into it are being skipped.</ng-container></p> }
                <div class="chips">@for (list of mirror.lists; track list.sourceListId) { <span>{{ list.sourceListName }} <i class="ti ti-arrow-right"></i> {{ list.targetListName }}</span> }</div>
                <ng-container *ngTemplateOutlet="mirrorEditor; context: { $implicit: mirror, deleteLabel: deleteMirrorLabel }" />
              </article>
            } @empty { <p class="empty" i18n>This board does not feed another board.</p> }
          </div>
          @if (error(); as message) { <p class="error" role="alert"><i class="ti ti-alert-circle"></i>{{ message }}</p> }
        }
      </section>
    </div>
  `,
  styles: [`
    .backdrop{position:fixed;inset:0;z-index:10020;background:rgba(0,0,0,.52);display:flex;align-items:center;justify-content:center;padding:16px}.dialog{width:min(680px,100%);max-height:min(820px,92vh);overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:0 24px 70px rgba(0,0,0,.35)}header{display:flex;justify-content:space-between;gap:16px;padding:20px;border-bottom:1px solid var(--border)}h2{font-size:17px;margin:0;color:var(--text)}header p{font-size:12px;color:var(--text-muted);margin:4px 0 0}.icon{border:0;background:transparent;color:var(--text-muted);font-size:18px}.loading,.empty,.error{padding:16px 20px;color:var(--text-muted);font-size:13px}.error{color:var(--danger)}.topology-banner{display:flex;align-items:flex-start;gap:9px;margin:16px 20px 0;padding:11px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface-2)}.topology-banner>i{margin-top:1px;color:var(--accent);font-size:17px}.topology-banner div{display:flex;flex-direction:column;gap:3px}.topology-banner strong{color:var(--text);font-size:12px}.topology-banner span{color:var(--text-muted);font-size:11px;line-height:1.4}.topology-banner.danger{border-color:color-mix(in srgb,var(--danger) 35%,var(--border));background:color-mix(in srgb,var(--danger) 7%,var(--surface))}.topology-banner.danger>i,.topology-banner.danger strong{color:var(--danger)}.section{padding:18px 20px;border-bottom:1px solid var(--border)}h3{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted)}h3 span{display:flex;align-items:center;gap:4px;font-size:10px;font-weight:500;letter-spacing:0;text-transform:none}.mirror-card{border:1px solid var(--border);border-radius:var(--radius-md);padding:13px;margin-bottom:10px;background:var(--surface-subtle,transparent)}.mirror-title{display:flex;justify-content:space-between;gap:12px}.mirror-title div{display:flex;flex-direction:column;gap:2px}.mirror-title strong{font-size:13px;color:var(--text)}.mirror-title span,.sync-line{font-size:11px;color:var(--text-muted)}.status{padding:3px 7px;border:1px solid var(--border);border-radius:999px;height:max-content}.status.warn,.warning{color:var(--warning)}.sync-line{margin:9px 0}.warning{font-size:12px;display:flex;gap:6px}.chips{display:flex;flex-wrap:wrap;gap:5px}.chips span{font-size:11px;padding:3px 7px;border-radius:999px;background:var(--surface-hover);color:var(--text-muted)}.actions,.edit-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:12px}.actions button,.edit-actions button{height:30px;padding:0 10px;font-size:12px}.read-only{color:var(--text-muted);font-size:12px}.state-action.is-restorative{border-color:color-mix(in srgb,var(--accent) 35%,var(--border));color:var(--accent)}button.danger{background:var(--danger);border-color:var(--danger)}button.danger-text{color:var(--danger)}button:disabled{opacity:.5}.mapping-editor{margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}.mapping-copy{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}.mapping-copy strong{color:var(--text);font-size:13px}.mapping-copy span{color:var(--text-muted);font-size:12px}.mapping-grid{display:grid;gap:8px}.mapping-grid-heading,.mapping-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(190px,1fr);align-items:center;gap:16px}.mapping-grid-heading{padding:0 12px;color:var(--text-muted);font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}.mapping-row{min-height:52px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface-2)}.mapping-grid:not(.has-targets) .mapping-row{grid-template-columns:1fr}.mapping-choice{display:flex;min-width:0;align-items:center;gap:10px;color:var(--text);font-size:12px;font-weight:600;cursor:pointer}.mapping-choice input{width:16px;height:16px;flex:0 0 auto}.mapping-choice span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mapping-row select:disabled{opacity:.55}.edit-actions{justify-content:flex-end}.mapping-row select{width:100%}@media(max-width:560px){.mapping-grid-heading{display:none}.mapping-grid-heading,.mapping-row{grid-template-columns:1fr;gap:8px}.dialog{max-height:100%}}
  `],
})
export class BoardMirrorsDialogComponent implements OnInit {
  private readonly mirrors = inject(BoardMirrorsService);
  private initialized = false;
  readonly boardId = input.required<string>();
  readonly refreshVersion = input(0);
  readonly dismissed = output<void>();
  readonly mirrorCountChange = output<number>();
  readonly inbound = signal<BoardMirrorRow[]>([]);
  readonly outbound = signal<BoardMirrorRow[]>([]);
  readonly loading = signal(true);
  readonly busyId = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly confirmDeleteId = signal<string | null>(null);
  readonly editingId = signal<string | null>(null);
  readonly editSelected = signal(new Set<string>());
  readonly editTargets = signal<Record<string, string>>({});

  constructor() {
    effect(() => {
      this.refreshVersion();
      if (!this.initialized) return;
      void this.refresh();
    });
  }

  async ngOnInit() {
    const versionBeforeLoad = this.refreshVersion();
    await this.refresh();
    this.initialized = true;
    // An event can land while the initial requests are in flight. Replay once if its invalidation
    // version advanced so a pre-event response cannot leave the just-opened dialog stale.
    if (this.refreshVersion() !== versionBeforeLoad) await this.refresh();
  }
  private async refresh() {
    try {
      const [inbound, outbound] = await Promise.all([this.mirrors.inbound(this.boardId()), this.mirrors.outbound(this.boardId())]);
      this.inbound.set(inbound); this.outbound.set(outbound); this.error.set(null);
      this.mirrorCountChange.emit(inbound.length + outbound.length);
    } catch { this.error.set($localize`Board mirrors could not be loaded.`); }
    finally { this.loading.set(false); this.busyId.set(null); }
  }
  readonly deleteLabel = $localize`:Button — delete an inbound board mirror:Delete`;
  readonly deleteMirrorLabel = $localize`:Button — delete an outbound board mirror:Delete mirror`;
  targetListLabel(listName: string) { return $localize`:Accessible name of a select choosing the target list:Target list for ${listName}:listName:`; }
  statusLabel(mirror: BoardMirrorRow) { return mirror.planBlocked ? MIRROR_STATUS.proRequired : mirror.sourceDisabledAt ? MIRROR_STATUS.disabledBySource : mirror.pausedAt ? MIRROR_STATUS.paused : mirror.lastError ? MIRROR_STATUS.needsAttention : MIRROR_STATUS.active; }
  outboundStatusLabel(mirror: BoardMirrorRow) { return mirror.planBlocked ? MIRROR_STATUS.proRequired : mirror.sourceDisabledAt ? MIRROR_STATUS.disabledBySource : mirror.pausedAt ? MIRROR_STATUS.pausedByTarget : MIRROR_STATUS.active; }
  hasArchivedTarget(mirror: BoardMirrorRow) { return mirror.lists.some((list) => list.targetListArchived); }
  syncLine(mirror: BoardMirrorRow) { return mirror.planBlocked ? $localize`Plan-blocked; no changes are being copied` : mirror.lastError ? mirror.lastError : mirror.lastSyncAt ? $localize`:Board mirror sync status:Last checked ${formatDateTime(mirror.lastSyncAt, "medium")}:dateTime:` : $localize`:Board mirror sync status:Waiting for first sync`; }
  private errorMessage(error: unknown, fallback: string) { return error instanceof ApiError && error.body && typeof error.body === "object" && "message" in error.body ? String(error.body.message) : fallback; }
  async togglePause(mirror: BoardMirrorRow) { this.busyId.set(mirror.id); await this.mirrors.update(this.boardId(), mirror.id, { paused: !mirror.pausedAt }).then(() => this.refresh()).catch((error: unknown) => { this.error.set(this.errorMessage(error, $localize`The mirror state could not be changed.`)); this.busyId.set(null); }); }
  async toggleSource(mirror: BoardMirrorRow) { this.busyId.set(mirror.id); const request = mirror.sourceDisabledAt ? this.mirrors.sourceEnable(this.boardId(), mirror.id) : this.mirrors.sourceDisable(this.boardId(), mirror.id); await request.then(() => this.refresh()).catch((error: unknown) => { this.error.set(this.errorMessage(error, $localize`Outbound governance could not be changed.`)); this.busyId.set(null); }); }
  async remove(mirror: BoardMirrorRow) { this.busyId.set(mirror.id); await this.mirrors.remove(this.boardId(), mirror.id).then(() => this.refresh()).catch((error: unknown) => { this.error.set(this.errorMessage(error, $localize`The mirror could not be deleted.`)); this.busyId.set(null); }); }
  editLists(mirror: BoardMirrorRow) { this.editingId.set(mirror.id); this.editSelected.set(new Set(mirror.lists.map((list) => list.sourceListId))); this.editTargets.set(Object.fromEntries(mirror.lists.map((list) => [list.sourceListId, list.targetListId]))); }
  toggleEditSource(sourceListId: string, checked: boolean, mirror: BoardMirrorRow) { this.editSelected.update((current) => { const next = new Set(current); if (checked) next.add(sourceListId); else next.delete(sourceListId); return next; }); if (checked && mirror.sourceWorkspaceId !== mirror.targetWorkspaceId && !this.editTargets()[sourceListId]) { const name = mirror.availableSourceLists.find((list) => list.id === sourceListId)?.name; const match = mirror.availableTargetLists.filter((list) => list.name === name); if (match.length === 1) this.setEditTarget(sourceListId, match[0]!.id); } }
  setEditTarget(sourceListId: string, targetListId: string) { this.editTargets.update((current) => ({ ...current, [sourceListId]: targetListId })); }
  canSaveLists(mirror: BoardMirrorRow) { return this.editSelected().size > 0 && (mirror.sourceWorkspaceId === mirror.targetWorkspaceId || [...this.editSelected()].every((id) => Boolean(this.editTargets()[id]))); }
  async saveLists(mirror: BoardMirrorRow) { if (!this.canSaveLists(mirror)) return; this.busyId.set(mirror.id); await this.mirrors.update(this.boardId(), mirror.id, { lists: [...this.editSelected()].map((sourceListId) => ({ sourceListId, ...(mirror.sourceWorkspaceId !== mirror.targetWorkspaceId && { targetListId: this.editTargets()[sourceListId] }) })) }).then(() => { this.editingId.set(null); return this.refresh(); }).catch((error: unknown) => { this.error.set(this.errorMessage(error, $localize`List mappings could not be saved.`)); this.busyId.set(null); }); }
}
