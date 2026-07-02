import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, HostListener, computed, inject, input, output, signal } from "@angular/core";
import type { CompactCardCustomFieldValue, WireBoardMemberUser, WireCard, WireCardSummary, WireCustomFieldOption } from "@kanera/shared/events";
import { expandCardCustomFieldValue } from "@kanera/shared/events";
import type { Card, CardCustomFieldValue } from "@kanera/shared/schema";
import { ApiClient } from "../../core/api/api.client";
import { AvatarComponent } from "../../shared/avatar.component";
import { BoardState, type AnyCustomField } from "./board-state";
import { cardIdBatchesByBoard, cardIdsByBoard } from "./bulk-card-batches.util";

type AnyCard = Card | WireCard | WireCardSummary;

// Value columns sent to the bulk endpoint. Only the column matching the field type is set.
type ValuePayload = {
  valueText?: string | null;
  valueNumber?: number | null;
  valueCheckbox?: boolean | null;
  valueDate?: string | null;
  valueUrl?: string | null;
  valueOptionIds?: string[] | null;
  valueUserIds?: string[] | null;
};

// A field's pending edit. Single-value fields stage a whole-value write ("set") or a "clear";
// multi-value select/user stage id-level add/remove toggles (or a full "clear").
type FieldStage =
  | { type: "set"; scope: "setAll" | "fillEmpty"; value: ValuePayload }
  | { type: "clear" }
  | { type: "multi"; addIds: string[]; removeIds: string[] };

interface BulkCustomFieldResult {
  values: CardCustomFieldValue[];
  clearedCardIds: string[];
  skippedCardIds: string[];
  updated: number;
}

type TriState = "all" | "mixed" | "none";

@Component({
  selector: "k-bulk-custom-fields-dialog",
  standalone: true,
  imports: [AvatarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="backdrop" (click)="dismiss()">
      <div class="dialog" (click)="$event.stopPropagation()" role="dialog" aria-label="Edit custom fields" [attr.aria-busy]="loading() || saving()">
        <header class="head">
          <div>
            <h3 class="title">Edit custom fields</h3>
            <p class="sub">{{ cardIds().length }} card{{ cardIds().length === 1 ? '' : 's' }} selected</p>
          </div>
          <button type="button" class="icon-btn" (click)="dismiss()" aria-label="Close" [disabled]="saving()"><i class="ti ti-x"></i></button>
        </header>

        @if (saving()) {
          <div class="saving-state" role="status">
            <i class="ti ti-loader-2 kanera-spin"></i>
            <strong>Saving changes…</strong>
            <span>Updating {{ cardIds().length }} card{{ cardIds().length === 1 ? '' : 's' }}. This may take a moment.</span>
          </div>
        } @else if (loading()) {
          <p class="notice"><i class="ti ti-loader-2 kanera-spin"></i><span>Loading current values…</span></p>
        } @else {
          <div class="fields">
            @for (field of fields(); track field.id) {
              <div class="field" [class.is-open]="expandedId() === field.id" [class.is-staged]="isStaged(field.id)">
                <button type="button" class="field-head" (click)="toggle(field.id)">
                  <i class="fi" [class]="'ti ti-' + (field.icon || 'forms')"></i>
                  <span class="fname">{{ field.name }}</span>
                  <span class="fsummary">{{ stagedSummary(field) ?? currentSummary(field) }}</span>
                  <i class="chev ti" [class.ti-chevron-down]="expandedId() === field.id" [class.ti-chevron-right]="expandedId() !== field.id"></i>
                </button>

                @if (expandedId() === field.id) {
                  <div class="editor">
                    @switch (field.type) {
                      @case ('checkbox') {
                        <div class="seg">
                          <button type="button" [class.on]="checkboxStaged(field.id) === true" (click)="stageCheckbox(field, true)">Checked</button>
                          <button type="button" [class.on]="checkboxStaged(field.id) === false" (click)="stageCheckbox(field, false)">Unchecked</button>
                        </div>
                      }
                      @case ('number') {
                        <input class="in" type="number" [value]="numberStaged(field.id) ?? ''"
                          (input)="stageNumber(field, $any($event.target).value)" placeholder="Set number…" />
                      }
                      @case ('date') {
                        <input class="in" type="date" [value]="scalarStaged(field.id, 'valueDate') ?? ''"
                          (input)="stageScalar(field, 'valueDate', $any($event.target).value || null)" />
                      }
                      @case ('url') {
                        <input class="in" type="url" [value]="scalarStaged(field.id, 'valueUrl') ?? ''"
                          (input)="stageScalar(field, 'valueUrl', $any($event.target).value || null)" placeholder="https://…" />
                      }
                      @case ('select') {
                        <div class="rows">
                          @for (opt of optionsForField(field); track opt.id) {
                            <button type="button" class="row" [class.sel]="optionSelected(field, opt.id) !== 'none'" (click)="toggleOption(field, opt.id)">
                              <span class="dot" [style.background]="opt.color ? 'var(--color-' + opt.color + ')' : 'var(--border-strong)'"></span>
                              <span class="rlabel">{{ opt.label }}</span>
                              @if (optionSelected(field, opt.id) === 'all') { <i class="ti ti-check"></i> }
                              @else if (optionSelected(field, opt.id) === 'mixed') { <i class="ti ti-square-half"></i> }
                            </button>
                          } @empty {
                            <p class="empty">No options</p>
                          }
                        </div>
                      }
                      @case ('user') {
                        <div class="rows">
                          @for (m of members(); track m.userId) {
                            <button type="button" class="row" [class.sel]="userSelected(field, m.userId) !== 'none'" (click)="toggleUser(field, m.userId)">
                              <k-avatar [url]="m.avatarUrl" [name]="m.displayName" [size]="22" [userId]="m.userId" />
                              <span class="rlabel">{{ m.userId === currentUserId() ? 'Me' : m.displayName }}</span>
                              @if (userSelected(field, m.userId) === 'all') { <i class="ti ti-check"></i> }
                              @else if (userSelected(field, m.userId) === 'mixed') { <i class="ti ti-square-half"></i> }
                            </button>
                          } @empty {
                            <p class="empty">No members</p>
                          }
                        </div>
                      }
                      @default {
                        <input class="in" type="text" [value]="scalarStaged(field.id, 'valueText') ?? ''"
                          (input)="stageScalar(field, 'valueText', $any($event.target).value)" placeholder="Set text…" />
                      }
                    }

                    <div class="editor-foot">
                      @if (!isMulti(field)) {
                        <!-- Scope only matters once a value is staged: apply to all, or only to cards with no value yet. -->
                        <div class="scope" [class.disabled]="!hasSetStage(field.id)">
                          <button type="button" [class.on]="scopeFor(field.id) === 'setAll'" (click)="setScope(field, 'setAll')" [disabled]="!hasSetStage(field.id)">All cards</button>
                          <button type="button" [class.on]="scopeFor(field.id) === 'fillEmpty'" (click)="setScope(field, 'fillEmpty')" [disabled]="!hasSetStage(field.id)">Only empty</button>
                        </div>
                      }
                      <button type="button" class="clear-btn" (click)="stageClear(field)" [class.on]="isClearStaged(field.id)">Clear on all</button>
                    </div>
                  </div>
                }
              </div>
            } @empty {
              <p class="empty">This workspace has no custom fields.</p>
            }
          </div>

          @if (applyNotice(); as notice) {
            <p class="notice skip"><i class="ti ti-info-circle"></i><span>{{ notice }}</span></p>
          }

          <footer class="foot">
            <button type="button" class="ghost sm" (click)="dismiss()">{{ applyNotice() ? 'Close' : 'Cancel' }}</button>
            <button type="button" class="sm" (click)="apply()" [disabled]="saving() || stagedCount() === 0">
              @if (saving()) { <i class="ti ti-loader-2 kanera-spin"></i> }
              Apply{{ stagedCount() > 0 ? ' (' + stagedCount() + ')' : '' }}
            </button>
          </footer>
        }
      </div>
    </div>
  `,
  styles: `
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      animation: fade-in 120ms ease;
    }
    .dialog {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      width: 100%;
      max-width: 460px;
      max-height: min(80vh, 720px);
      display: flex;
      flex-direction: column;
      animation: slide-in 120ms ease;
    }
    .head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
      padding: 18px 20px 12px;
    }
    .title { font-size: 15px; font-weight: 600; color: var(--text); margin: 0; }
    .sub { font-size: 12px; color: var(--text-muted); margin: 2px 0 0; }
    .icon-btn {
      border: none;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 16px;
      padding: 2px;
      border-radius: var(--radius-sm);
    }
    .icon-btn:hover { background: var(--surface-hover); color: var(--text); }
    .icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .saving-state {
      min-height: 220px;
      padding: 32px 20px;
      display: flex;
      flex: 1;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      text-align: center;
      color: var(--text-muted);
      font-size: 13px;
    }
    .saving-state > i { margin-bottom: 4px; color: var(--accent, var(--text)); font-size: 24px; }
    .saving-state > strong { color: var(--text); font-size: 14px; font-weight: 600; }
    .fields { overflow-y: auto; padding: 0 12px; flex: 1; }
    .field { border-bottom: 1px solid var(--border); }
    .field:last-child { border-bottom: none; }
    .field-head {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 11px 8px;
      background: transparent;
      border: none;
      cursor: pointer;
      text-align: left;
      color: var(--text);
    }
    .field-head:hover { background: var(--surface-hover); }
    .field-head .fi { width: 16px; flex: 0 0 16px; color: var(--text-muted); }
    .fname { font-size: 13px; font-weight: 500; flex: 0 0 auto; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fsummary { flex: 1; min-width: 0; font-size: 12px; color: var(--text-muted); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .is-staged .fsummary { color: var(--accent, var(--text)); font-weight: 500; }
    .chev { font-size: 13px; color: var(--text-muted); flex: 0 0 auto; }
    .editor { padding: 4px 8px 14px; display: flex; flex-direction: column; gap: 10px; }
    .in {
      width: 100%;
      padding: 7px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface-2, var(--surface));
      color: var(--text);
      font-size: 13px;
    }
    .in:focus { outline: none; border-color: var(--accent, var(--border-strong)); }
    .seg, .scope {
      display: inline-flex;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      overflow: hidden;
      width: fit-content;
    }
    .seg button, .scope button {
      border: none;
      background: var(--surface);
      color: var(--text-muted);
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
    }
    .seg button + button, .scope button + button { border-left: 1px solid var(--border); }
    .seg button.on, .scope button.on { background: var(--accent, var(--surface-2)); color: #fff; }
    .scope.disabled { opacity: 0.5; }
    .rows { display: flex; flex-direction: column; gap: 2px; max-height: 190px; overflow-y: auto; }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: 32px;
      padding: 5px 8px;
      border: none;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text);
      cursor: pointer;
      text-align: left;
    }
    .row:hover, .row.sel { background: var(--surface-2); }
    .row .rlabel { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
    .row > i { color: var(--accent, var(--text)); font-size: 14px; }
    .dot { width: 12px; height: 12px; border-radius: 50%; flex: 0 0 12px; }
    .editor-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .clear-btn {
      border: none;
      background: transparent;
      color: var(--text-muted);
      font-size: 12px;
      cursor: pointer;
      padding: 4px 6px;
      border-radius: var(--radius-sm);
    }
    .clear-btn:hover { background: var(--surface-hover); color: var(--danger, #d33); }
    .clear-btn.on { color: var(--danger, #d33); font-weight: 600; }
    .empty { margin: 0; padding: 14px 8px; color: var(--text-muted); font-size: 13px; text-align: center; }
    .notice {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      padding: 16px 20px;
      color: var(--text-muted);
      font-size: 13px;
    }
    .notice.skip { padding: 8px 20px; }
    .foot { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 20px 18px; border-top: 1px solid var(--border); }
    @keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
    @keyframes slide-in { from { opacity: 0; transform: scale(0.96) translateY(-4px) } to { opacity: 1; transform: none } }
  `,
})
export class BulkCustomFieldsDialogComponent implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly state = inject(BoardState);

  readonly boardId = input.required<string>();
  readonly cardIds = input.required<string[]>();
  readonly cards = input.required<AnyCard[]>();
  readonly customFields = input.required<AnyCustomField[]>();
  readonly members = input.required<WireBoardMemberUser[]>();
  readonly currentUserId = input<string | null | undefined>(null);
  readonly dismissed = output<void>();
  readonly done = output<void>();

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly expandedId = signal<string | null>(null);
  readonly applyNotice = signal<string | null>(null);
  // Staged edits keyed by fieldId. Immutable Map updates keep OnPush change detection honest.
  private readonly staged = signal<Map<string, FieldStage>>(new Map());

  readonly fields = computed(() => this.customFields().filter((f) => !("archivedAt" in f) || !f.archivedAt));
  private readonly fieldsById = computed(() => new Map(this.fields().map((f) => [f.id, f])));
  readonly stagedCount = computed(() => this.staged().size);

  ngOnInit() {
    // The open payload only includes showOnCard fields. Fetch every field for the selected cards,
    // not the entire board; Assigned Work may span several large boards for a small selection.
    // Batches for boards already fully cached are omitted without weakening that cache marker.
    const batches = [...cardIdsByBoard(this.cardIds(), this.cards(), this.boardId())]
      .filter(([boardId]) => !this.state.hasFullCfValuesForBoard(boardId));
    if (batches.length === 0) return;
    this.loading.set(true);
    void Promise.all(
      batches.map(([boardId, cardIds]) =>
        this.api
          .post<{ customFieldValues: CompactCardCustomFieldValue[] }>(`/boards/${boardId}/custom-field-values/query`, { cardIds })
          .then((res) => {
            this.state.mergeCustomFieldValues(res.customFieldValues.map(expandCardCustomFieldValue));
          })
          .catch(() => undefined),
      ),
    ).finally(() => this.loading.set(false));
  }

  @HostListener("document:keydown.escape")
  onEscape() {
    if (!this.saving()) this.dismiss();
  }

  isMulti(field: AnyCustomField): boolean {
    return (field.type === "select" || field.type === "user") && field.allowMultiple;
  }

  optionsForField(field: AnyCustomField): WireCustomFieldOption[] {
    return "options" in field ? field.options : [];
  }

  toggle(fieldId: string) {
    this.expandedId.update((cur) => (cur === fieldId ? null : fieldId));
  }

  isStaged(fieldId: string): boolean {
    return this.staged().has(fieldId);
  }

  isClearStaged(fieldId: string): boolean {
    return this.staged().get(fieldId)?.type === "clear";
  }

  hasSetStage(fieldId: string): boolean {
    return this.staged().get(fieldId)?.type === "set";
  }

  scopeFor(fieldId: string): "setAll" | "fillEmpty" {
    const stage = this.staged().get(fieldId);
    return stage?.type === "set" ? stage.scope : "setAll";
  }

  // --- Current value inspection across the selected cards -------------------

  private cellForCard(field: AnyCustomField, cardId: string): string | null {
    const v = this.state.customFieldValuesForCard(cardId).get(field.id);
    switch (field.type) {
      case "text": return v?.valueText ?? null;
      case "number": return v?.valueNumber ?? null;
      case "checkbox": return String(v?.valueCheckbox === true);
      case "date": return v?.valueDate ?? null;
      case "url": return v?.valueUrl ?? null;
      case "select": return v?.valueOptionIds?.[0] ?? null;
      case "user": return v?.valueUserIds?.[0] ?? null;
      default: return null;
    }
  }

  private sharedCell(field: AnyCustomField): { mixed: boolean; value: string | null } {
    let first: string | null | undefined;
    for (const cardId of this.cardIds()) {
      const cell = this.cellForCard(field, cardId);
      if (first === undefined) first = cell;
      else if (first !== cell) return { mixed: true, value: null };
    }
    return { mixed: false, value: first ?? null };
  }

  /** Tri-state for one option/user id across the selected cards. */
  private idState(field: AnyCustomField, id: string, key: "valueOptionIds" | "valueUserIds"): TriState {
    const total = this.cardIds().length;
    let count = 0;
    for (const cardId of this.cardIds()) {
      const ids = this.state.customFieldValuesForCard(cardId).get(field.id)?.[key] ?? [];
      if (ids.includes(id)) count++;
    }
    return count === 0 ? "none" : count === total ? "all" : "mixed";
  }

  currentSummary(field: AnyCustomField): string {
    if (this.isMulti(field)) return ""; // multi rows show their own tri-state
    const { mixed, value } = this.sharedCell(field);
    if (mixed) return "Mixed";
    if (value === null) return "—";
    if (field.type === "checkbox") return value === "true" ? "Checked" : "Unchecked";
    if (field.type === "select") return this.optionsForField(field).find((o) => o.id === value)?.label ?? "1 selected";
    if (field.type === "user") return this.members().find((m) => m.userId === value)?.displayName ?? "1 selected";
    return value;
  }

  // --- Staged-edit summary --------------------------------------------------

  stagedSummary(field: AnyCustomField): string | null {
    const stage = this.staged().get(field.id);
    if (!stage) return null;
    if (stage.type === "clear") return "Will clear";
    if (stage.type === "multi") {
      const parts: string[] = [];
      if (stage.addIds.length) parts.push(`+${stage.addIds.length}`);
      if (stage.removeIds.length) parts.push(`−${stage.removeIds.length}`);
      return parts.length ? parts.join(" ") : null;
    }
    const scope = stage.scope === "fillEmpty" ? " (empty only)" : "";
    return this.describeValue(field, stage.value) + scope;
  }

  private describeValue(field: AnyCustomField, value: ValuePayload): string {
    switch (field.type) {
      case "checkbox": return value.valueCheckbox ? "→ Checked" : "→ Unchecked";
      case "select": return "→ " + (this.optionsForField(field).find((o) => o.id === value.valueOptionIds?.[0])?.label ?? "1 selected");
      case "user": return "→ " + (this.members().find((m) => m.userId === value.valueUserIds?.[0])?.displayName ?? "1 selected");
      case "number": return value.valueNumber == null ? "Will clear" : `→ ${value.valueNumber}`;
      case "date": return value.valueDate ? `→ ${value.valueDate}` : "Will clear";
      case "url": return value.valueUrl ? `→ ${value.valueUrl}` : "Will clear";
      default: return value.valueText ? `→ ${value.valueText}` : "Will clear";
    }
  }

  // --- Editor bindings ------------------------------------------------------

  scalarStaged(fieldId: string, key: "valueText" | "valueDate" | "valueUrl"): string | null {
    const stage = this.staged().get(fieldId);
    return stage?.type === "set" ? (stage.value[key] ?? null) : null;
  }

  numberStaged(fieldId: string): number | null {
    const stage = this.staged().get(fieldId);
    return stage?.type === "set" ? (stage.value.valueNumber ?? null) : null;
  }

  checkboxStaged(fieldId: string): boolean | null {
    const stage = this.staged().get(fieldId);
    return stage?.type === "set" ? (stage.value.valueCheckbox ?? null) : null;
  }

  optionSelected(field: AnyCustomField, optionId: string): TriState {
    return this.pickerState(field, optionId, "valueOptionIds");
  }

  userSelected(field: AnyCustomField, userId: string): TriState {
    return this.pickerState(field, userId, "valueUserIds");
  }

  /** Row highlight state: staged edits win, otherwise fall back to the cards' current state. */
  private pickerState(field: AnyCustomField, id: string, key: "valueOptionIds" | "valueUserIds"): TriState {
    const stage = this.staged().get(field.id);
    if (stage?.type === "clear") return "none";
    if (this.isMulti(field)) {
      if (stage?.type === "multi") {
        if (stage.addIds.includes(id)) return "all";
        if (stage.removeIds.includes(id)) return "none";
      }
      return this.idState(field, id, key);
    }
    // Single-value: a staged set replaces everything.
    if (stage?.type === "set") return stage.value[key]?.[0] === id ? "all" : "none";
    const { mixed, value } = this.sharedCell(field);
    if (mixed) return this.idState(field, id, key);
    return value === id ? "all" : "none";
  }

  // --- Staging actions ------------------------------------------------------

  private setStage(fieldId: string, stage: FieldStage | null) {
    this.staged.update((m) => {
      const next = new Map(m);
      if (stage === null) next.delete(fieldId);
      else next.set(fieldId, stage);
      return next;
    });
  }

  private stageSet(field: AnyCustomField, value: ValuePayload) {
    // Preserve the chosen scope when re-editing the same field.
    this.setStage(field.id, { type: "set", scope: this.scopeFor(field.id), value });
  }

  stageScalar(field: AnyCustomField, key: "valueText" | "valueDate" | "valueUrl", value: string | null) {
    this.stageSet(field, { [key]: value });
  }

  stageNumber(field: AnyCustomField, raw: string) {
    const value = raw === "" ? null : Number(raw);
    if (value !== null && Number.isNaN(value)) return;
    this.stageSet(field, { valueNumber: value });
  }

  stageCheckbox(field: AnyCustomField, checked: boolean) {
    const current = this.checkboxStaged(field.id);
    // Toggling the active choice again clears the staged edit.
    if (current === checked) this.setStage(field.id, null);
    else this.stageSet(field, { valueCheckbox: checked });
  }

  setScope(field: AnyCustomField, scope: "setAll" | "fillEmpty") {
    const stage = this.staged().get(field.id);
    if (stage?.type !== "set") return;
    this.setStage(field.id, { ...stage, scope });
  }

  toggleOption(field: AnyCustomField, optionId: string) {
    if (this.isMulti(field)) this.toggleMultiId(field, optionId, "valueOptionIds");
    else this.toggleSingleId(field, optionId, "valueOptionIds");
  }

  toggleUser(field: AnyCustomField, userId: string) {
    if (this.isMulti(field)) this.toggleMultiId(field, userId, "valueUserIds");
    else this.toggleSingleId(field, userId, "valueUserIds");
  }

  private toggleSingleId(field: AnyCustomField, id: string, key: "valueOptionIds" | "valueUserIds") {
    const stage = this.staged().get(field.id);
    // Clicking the already-staged option again reverts the stage.
    if (stage?.type === "set" && stage.value[key]?.[0] === id) this.setStage(field.id, null);
    else this.stageSet(field, { [key]: [id] });
  }

  private toggleMultiId(field: AnyCustomField, id: string, key: "valueOptionIds" | "valueUserIds") {
    const stage = this.staged().get(field.id);
    const base = stage?.type === "multi" ? stage : { type: "multi" as const, addIds: [] as string[], removeIds: [] as string[] };
    const inAdd = base.addIds.includes(id);
    const inRemove = base.removeIds.includes(id);
    let addIds = base.addIds;
    let removeIds = base.removeIds;
    if (inAdd) {
      addIds = addIds.filter((x) => x !== id);
    } else if (inRemove) {
      removeIds = removeIds.filter((x) => x !== id);
    } else {
      // No pending toggle yet: removing an id present on all cards, otherwise adding it.
      if (this.idState(field, id, key) === "all") removeIds = [...removeIds, id];
      else addIds = [...addIds, id];
    }
    if (addIds.length === 0 && removeIds.length === 0) this.setStage(field.id, null);
    else this.setStage(field.id, { type: "multi", addIds, removeIds });
  }

  stageClear(field: AnyCustomField) {
    if (this.isClearStaged(field.id)) this.setStage(field.id, null);
    else this.setStage(field.id, { type: "clear" });
  }

  // --- Apply ----------------------------------------------------------------

  dismiss() {
    // A bulk save can span several sequential field/board requests. Keep the dialog mounted so
    // the operation cannot appear cancelled while writes are still completing in the background.
    if (this.saving()) return;
    if (this.applyNotice()) this.done.emit(); // notice is shown post-apply; treat close as completion
    this.dismissed.emit();
  }

  async apply() {
    if (this.saving() || this.stagedCount() === 0) return;
    this.saving.set(true);
    this.applyNotice.set(null);
    const skipped = new Set<string>();
    try {
      for (const [fieldId, stage] of this.staged()) {
        const field = this.fieldsById().get(fieldId);
        if (!field) continue;
        if (stage.type === "clear") {
          await this.send(fieldId, { mode: "clear" }, skipped);
        } else if (stage.type === "set") {
          await this.send(fieldId, { mode: stage.scope, ...stage.value }, skipped);
        } else {
          const key = field.type === "user" ? "valueUserIds" : "valueOptionIds";
          if (stage.addIds.length) await this.send(fieldId, { mode: "add", [key]: stage.addIds }, skipped);
          if (stage.removeIds.length) await this.send(fieldId, { mode: "remove", [key]: stage.removeIds }, skipped);
        }
      }
    } finally {
      this.saving.set(false);
    }
    if (skipped.size > 0) {
      // Keep the dialog open to report ineligible (archived) cards; user closes explicitly.
      this.staged.set(new Map());
      this.applyNotice.set(`${skipped.size} card${skipped.size === 1 ? " was" : "s were"} skipped (archived).`);
      return;
    }
    this.done.emit();
    this.dismissed.emit();
  }

  private async send(fieldId: string, extra: Record<string, unknown>, skipped: Set<string>) {
    for (const [boardId, cardIds] of cardIdBatchesByBoard(this.cardIds(), this.cards(), this.boardId())) {
      const res = await this.api.patch<BulkCustomFieldResult>(`/boards/${boardId}/cards/bulk/custom-fields`, {
        cardIds,
        fieldId,
        ...extra,
      });
      // Optimistically reconcile board state; realtime events converge the rest.
      for (const value of res.values ?? []) this.state.upsertCustomFieldValue({ ...value, updatedAt: new Date(value.updatedAt) });
      for (const clearedId of res.clearedCardIds ?? []) this.state.clearCustomFieldValue(clearedId, fieldId);
      for (const id of res.skippedCardIds ?? []) skipped.add(id);
    }
  }
}
