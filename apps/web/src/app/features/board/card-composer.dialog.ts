import type { ElementRef, OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked, viewChild } from "@angular/core";
import { ALLOWED_ATTACHMENT_MIME, ALLOWED_ATTACHMENT_EXTENSIONS, getAllowedAttachmentExtension } from "@kanera/shared/attachments";
import type { WireBoardMemberUser, WireCard, WireCardLabel, WireCardSummary, WireChecklistTemplate, WireCustomFieldOption, WireList } from "@kanera/shared/events";
import type { Card, CardLabel, List } from "@kanera/shared/schema";
import { ApiClient } from "../../core/api/api.client";
import { UnsavedWorkService } from "../../core/browser/unsaved-work.service";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { attachmentIconClass } from "../../shared/attachment-icons";
import { AnchoredPickerPopover } from "../../shared/anchored-picker.popover";
import { AutofocusDirective } from "../../shared/autofocus.directive";
import { AvatarComponent } from "../../shared/avatar.component";
import { DraftBannerComponent } from "../../shared/draft-banner.component";
import { hasMarkdownContent } from "../../shared/markdown-content";
import type { PickerGroup } from "../../shared/picker-list.component";
import { PickerListComponent } from "../../shared/picker-list.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import type { AnyCustomField } from "./board-state";
import {
  emptyComposerDraft,
  draftHasContent,
  readComposerDraft,
  writeComposerDraft,
  type CardComposerDraft,
  type ComposerCustomFieldValue,
} from "./card-composer-draft";
import { DatePickerPopover } from "./date-picker.popover";
import { DescriptionEditorComponent } from "./description-editor.component";
import { formatDueDate, type DueDateSlot } from "./due-date.util";
import { LabelPickerPopover, type LabelPickerLabel } from "./label-picker.popover";
import { MemberPickerPopover } from "./member-picker.popover";
import { SelectPickerPopover } from "./select-picker.popover";

type AnyCard = Card | WireCard | WireCardSummary;
// Structural rather than the schema rows: the composer only reads these fields, so both a board's
// hydrated lists/labels and Global Work's catalog rows (which carry no timestamps) satisfy them.
type AnyList = { id: string; name: string; icon: string | null; color: string | null };
type AnyLabel = LabelPickerLabel;

/**
 * Values the opening surface has already decided. A column's `+` seeds the dimension that column
 * represents, so a card created from "Blocked" or from Alex's column lands there without the user
 * re-picking what they just pointed at.
 */
export interface CardComposerSeed {
  listId?: string;
  labelIds?: string[];
  assigneeIds?: string[];
  dueDateLocalDate?: string;
  dueDateSlot?: DueDateSlot;
  completed?: boolean;
  customFields?: Record<string, ComposerCustomFieldValue>;
  title?: string;
  /**
   * Where in the list the card lands. A list's own "Add card" menu entry has always inserted at the
   * top and the lane-footer button at the bottom; routing both through this dialog must not quietly
   * change that, so the opening surface still decides.
   */
  atTop?: boolean;
}

/** Which popover is currently open. Only one at a time; the key is the property it edits. */
type OpenPicker = { kind: "board" | "list" | "labels" | "assignees" | "due" | "checklists" } | { kind: "cf"; fieldId: string };

/**
 * A file staged before the card exists. The attachment endpoint is card-scoped, so there is nothing
 * to upload to until the create returns; the composer holds the `File` in memory and flushes the
 * whole set immediately afterwards. The key is only for `@for` tracking and removal — two drops of
 * the same file are two separate attachments, exactly as they would be on a card.
 */
interface PendingAttachment {
  key: string;
  file: File;
}

@Component({
  selector: "k-card-composer",
  standalone: true,
  imports: [
    AnchoredPanelDirective,
    AnchoredPickerPopover,
    AutofocusDirective,
    AvatarComponent,
    DatePickerPopover,
    DescriptionEditorComponent,
    DraftBannerComponent,
    LabelPickerPopover,
    MemberPickerPopover,
    PickerListComponent,
    SelectPickerPopover,
    TooltipDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./card-composer.dialog.html",
  styleUrl: "./card-composer.dialog.scss",
})
export class CardComposerDialogComponent implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly notifications = inject(NotificationsService);
  private readonly unsavedWork = inject(UnsavedWorkService);
  private readonly titleEl = viewChild<ElementRef<HTMLTextAreaElement>>("titleEl");
  private readonly descriptionEditor = viewChild<DescriptionEditorComponent>("descriptionEditor");

  readonly boardId = input.required<string>();
  readonly workspaceId = input<string | null>(null);
  readonly lists = input<AnyList[]>([]);
  readonly labels = input<AnyLabel[]>([]);
  readonly members = input<WireBoardMemberUser[]>([]);
  readonly customFields = input<AnyCustomField[]>([]);
  readonly checklistTemplates = input<WireChecklistTemplate[]>([]);
  readonly currentUserId = input<string | null>(null);
  readonly canEdit = input(true);
  readonly seed = input<CardComposerSeed | null>(null);
  /**
   * Boards the composer may retarget, as picker rows. Empty on a board page, where the board is
   * fixed; a cross-board host passes its candidates — already grouped the way that host groups
   * boards elsewhere — and owns `boardId` as a signal so the board-scoped inputs above follow the
   * selection.
   */
  readonly boardGroups = input<PickerGroup[]>([]);
  /**
   * Where the draft is stored. Defaults to the board id, which is right when the board is fixed; a
   * cross-board host passes a stable key of its own so switching boards mid-draft does not scatter
   * half-typed cards across per-board slots.
   */
  readonly draftKey = input<string>("");

  readonly created = output<AnyCard>();
  readonly dismissed = output<void>();
  /** Emitted when the user retargets the board, so a cross-board host can re-derive its inputs. */
  readonly boardIdChange = output<string>();

  readonly draft = signal<CardComposerDraft>(emptyComposerDraft());
  readonly openPicker = signal<OpenPicker | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  /** Set once a stored draft was restored, so the banner explains why fields are pre-filled. */
  readonly recoveredDraft = signal(false);
  /**
   * Read once by the description editor when it mounts. The live value lives in the draft signal;
   * the editor is uncontrolled after mount, so binding the draft directly would be a lie.
   */
  readonly descriptionInitial = signal("");
  /** Keeps the composer open after a successful create, for entering a run of cards in one sitting. */
  readonly createAnother = signal(false);
  /**
   * Files waiting for the card to exist. Deliberately outside the draft: a `File` is a handle to
   * something the browser owns, so it cannot be serialised into localStorage and would not survive a
   * reload even if it could. That makes staged files the one part of the composer that is genuinely
   * lost on dismissal, which is why closing prompts once any are staged.
   */
  readonly pendingAttachments = signal<PendingAttachment[]>([]);
  /** True while a file drag is over the dialog, so the drop target is visible before the drop. */
  readonly dragActive = signal(false);
  /** Staging-time complaints (unsupported type). Upload failures surface through `error` instead. */
  readonly attachmentError = signal<string | null>(null);
  /** Insert position for the create call; see CardComposerSeed.atTop. Not user content, so not drafted. */
  private readonly atTop = signal(false);
  /** Last board the pruning effect reconciled against, so it only reacts to an actual change. */
  private lastTarget: { boardId: string; workspaceId: string | null } | null = null;

  readonly storageKey = computed(() => this.draftKey() || this.boardId());

  constructor() {
    // Persist on every edit rather than on close: the value of a draft is that it survives the
    // cases where no close handler runs — a reload, a crash, a phone killing the tab.
    effect(() => {
      const draft = this.draft();
      const key = this.storageKey();
      if (!key) return;
      writeComposerDraft(key, draft);
    });

    // Retargeting the board invalidates selections the new board cannot honour: lists, labels and
    // custom fields are workspace-scoped, and members are board-scoped. Clearing them here is what
    // stops the create sending ids the target board would reject.
    effect(() => {
      const boardId = this.boardId();
      const workspaceId = this.workspaceId();
      untracked(() => {
        const previous = this.lastTarget;
        this.lastTarget = { boardId, workspaceId };
        if (!previous || previous.boardId === boardId) return;
        const workspaceChanged = previous.workspaceId !== workspaceId;
        this.draft.update((draft) => ({
          ...draft,
          boardId,
          assigneeIds: [],
          ...(workspaceChanged
            ? { listId: "", labelIds: [], checklistTemplateIds: [], customFields: {} }
            : {}),
        }));
      });
    });

    // Keeps a valid list selected as the board's lists arrive (a tick after a board change) and
    // repairs a restored draft whose list has since been deleted.
    effect(() => {
      const lists = this.lists();
      if (lists.length === 0) return;
      untracked(() => {
        const listId = this.draft().listId;
        if (listId && lists.some((list) => list.id === listId)) return;
        this.patch({ listId: lists[0].id });
      });
    });
  }

  ngOnInit(): void {
    const stored = readComposerDraft(this.storageKey());
    const base = stored ?? emptyComposerDraft();
    this.recoveredDraft.set(Boolean(stored && draftHasContent(stored)));
    this.atTop.set(this.seed()?.atTop ?? false);
    // The seed wins over the draft for the properties it names. The user pointed at that column a
    // moment ago; a week-old draft's list must not silently override where they just clicked.
    const draft = this.applySeed(base, this.seed());
    this.draft.set(draft);
    this.descriptionInitial.set(draft.description);
    // A cross-board draft carries its own board; tell the host so its board-scoped inputs match what
    // was restored rather than whatever board it happened to default to.
    if (draft.boardId && draft.boardId !== this.boardId()) this.boardIdChange.emit(draft.boardId);
  }

  private applySeed(draft: CardComposerDraft, seed: CardComposerSeed | null): CardComposerDraft {
    const next: CardComposerDraft = { ...draft };
    // A restored cross-board draft keeps the board it was aimed at; anything else takes the host's.
    if (!next.boardId) next.boardId = this.boardId();
    if (!next.listId) next.listId = this.lists()[0]?.id ?? "";
    if (!seed) return next;
    if (seed.title !== undefined && !next.title.trim()) next.title = seed.title;
    if (seed.listId) next.listId = seed.listId;
    if (seed.labelIds?.length) next.labelIds = mergeIds(next.labelIds, seed.labelIds);
    if (seed.assigneeIds?.length) next.assigneeIds = mergeIds(next.assigneeIds, seed.assigneeIds);
    if (seed.dueDateLocalDate) {
      next.dueDateLocalDate = seed.dueDateLocalDate;
      next.dueDateSlot = seed.dueDateSlot ?? "anyTime";
    }
    if (seed.completed !== undefined) next.completed = seed.completed;
    if (seed.customFields) next.customFields = { ...next.customFields, ...seed.customFields };
    return next;
  }

  // ─── Derived presentation ───────────────────────────────────────────────────

  /** The board chip only appears where there is a choice to make. */
  readonly showBoardPicker = computed(() => this.boardGroups().some((group) => group.options.length > 0));
  /** The chip renders from the picker row itself, so the two can never disagree about a board. */
  readonly selectedBoard = computed(() =>
    this.boardGroups().flatMap((group) => group.options).find((option) => option.id === this.boardId()) ?? null
  );

  readonly selectedList = computed(() => this.lists().find((list) => list.id === this.draft().listId) ?? null);
  readonly listGroups = computed<PickerGroup[]>(() => [{
    id: "lists",
    options: this.lists().map((list) => ({
      id: list.id,
      label: list.name,
      icon: list.icon || "list",
      color: list.color,
    })),
  }]);

  readonly selectedLabels = computed(() => {
    const ids = new Set(this.draft().labelIds);
    return this.labels().filter((label) => ids.has(label.id));
  });
  readonly selectedLabelNames = computed(() => this.selectedLabels().map((label) => label.name).join(", "));
  /** Three swatches communicate a multi-label selection without letting the chip grow unbounded. */
  readonly selectedLabelPreview = computed(() => this.selectedLabels().slice(0, 3));

  readonly selectedAssignees = computed(() => {
    const ids = new Set(this.draft().assigneeIds);
    return this.members().filter((member) => ids.has(member.userId));
  });

  readonly dueDateLabel = computed(() => {
    const draft = this.draft();
    if (!draft.dueDateLocalDate) return null;
    // Timezone is assigned server-side on write; render the draft in the browser's own zone.
    return formatDueDate(draft.dueDateLocalDate, draft.dueDateSlot, Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  readonly selectedChecklistTemplates = computed(() => {
    const ids = new Set(this.draft().checklistTemplateIds);
    return this.checklistTemplates().filter((template) => ids.has(template.id));
  });

  readonly checklistTemplateGroups = computed<PickerGroup[]>(() => [{
    id: "templates",
    options: this.checklistTemplates().map((template) => ({
      id: template.id,
      label: template.title,
      icon: "checklist",
      trailing: `${template.items.length}`,
    })),
  }]);

  /** Archived fields are excluded upstream by BoardState; this only fixes the render order. */
  readonly orderedCustomFields = computed(() =>
    [...this.customFields()].sort((a, b) => Number(a.position) - Number(b.position))
  );

  readonly canSubmit = computed(() =>
    Boolean(this.draft().title.trim())
    && Boolean(this.boardId())
    && this.canEdit()
    && !this.busy()
  );

  optionsForField(field: AnyCustomField): WireCustomFieldOption[] {
    return "options" in field ? field.options : [];
  }

  allowMultiple(field: AnyCustomField): boolean {
    return "allowMultiple" in field && field.allowMultiple;
  }

  valueFor(fieldId: string): ComposerCustomFieldValue {
    return this.draft().customFields[fieldId] ?? {};
  }

  optionIdsFor(fieldId: string): string[] {
    return this.valueFor(fieldId).valueOptionIds ?? [];
  }

  userIdsFor(fieldId: string): string[] {
    return this.valueFor(fieldId).valueUserIds ?? [];
  }

  selectedOptionLabels(field: AnyCustomField): string {
    const ids = new Set(this.optionIdsFor(field.id));
    return this.optionsForField(field).filter((option) => ids.has(option.id)).map((option) => option.label).join(", ");
  }

  selectedUserNames(field: AnyCustomField): string {
    const ids = new Set(this.userIdsFor(field.id));
    return this.members().filter((member) => ids.has(member.userId)).map((member) => member.displayName).join(", ");
  }

  isPickerOpen(kind: OpenPicker["kind"], fieldId?: string): boolean {
    const open = this.openPicker();
    if (!open || open.kind !== kind) return false;
    return open.kind !== "cf" || open.fieldId === fieldId;
  }

  togglePicker(kind: Exclude<OpenPicker["kind"], "cf">): void {
    this.openPicker.update((open) => (open?.kind === kind ? null : { kind }));
  }

  toggleCfPicker(fieldId: string): void {
    this.openPicker.update((open) =>
      open?.kind === "cf" && open.fieldId === fieldId ? null : { kind: "cf", fieldId }
    );
  }

  closePicker(): void {
    this.openPicker.set(null);
  }

  // ─── Edits ──────────────────────────────────────────────────────────────────

  private patch(change: Partial<CardComposerDraft>): void {
    this.draft.update((draft) => ({ ...draft, ...change }));
  }

  setTitle(value: string): void {
    this.patch({ title: value });
  }

  setDescription(value: string): void {
    this.patch({ description: value });
  }

  selectBoard(boardId: string): void {
    this.closePicker();
    if (boardId === this.boardId()) return;
    // The host owns `boardId`; the pruning effect drops the now-invalid selections once it lands.
    this.boardIdChange.emit(boardId);
  }

  selectList(listId: string): void {
    this.patch({ listId });
    this.closePicker();
  }

  toggleLabel(labelId: string): void {
    this.patch({ labelIds: toggleId(this.draft().labelIds, labelId) });
  }

  toggleAssignee(userId: string): void {
    this.patch({ assigneeIds: toggleId(this.draft().assigneeIds, userId) });
  }

  toggleChecklistTemplate(templateId: string): void {
    this.patch({ checklistTemplateIds: toggleId(this.draft().checklistTemplateIds, templateId) });
  }

  setDueDate(value: string, slot: DueDateSlot = "anyTime"): void {
    this.patch({ dueDateLocalDate: value, dueDateSlot: value ? slot : "anyTime" });
    this.closePicker();
  }

  private setFieldValue(fieldId: string, value: ComposerCustomFieldValue | null): void {
    const next = { ...this.draft().customFields };
    // Storing an empty object would stage a request that writes nothing, and would make
    // `draftHasContent` treat an untouched field as unsaved work.
    if (!value || Object.keys(value).length === 0) delete next[fieldId];
    else next[fieldId] = value;
    this.patch({ customFields: next });
  }

  setTextField(field: AnyCustomField, raw: string): void {
    const value = raw.trim();
    this.setFieldValue(field.id, value ? { valueText: value } : null);
  }

  setNumberField(field: AnyCustomField, raw: string): void {
    const value = Number(raw);
    this.setFieldValue(field.id, raw.trim() && Number.isFinite(value) ? { valueNumber: value } : null);
  }

  setUrlField(field: AnyCustomField, raw: string): void {
    const value = raw.trim();
    this.setFieldValue(field.id, value ? { valueUrl: value } : null);
  }

  setDateField(field: AnyCustomField, value: string): void {
    this.setFieldValue(field.id, value ? { valueDate: value } : null);
    this.closePicker();
  }

  setCheckboxField(field: AnyCustomField, checked: boolean): void {
    this.setFieldValue(field.id, { valueCheckbox: checked });
  }

  toggleOption(field: AnyCustomField, optionId: string): void {
    const current = this.optionIdsFor(field.id);
    const next = this.allowMultiple(field)
      ? toggleId(current, optionId)
      : (current.includes(optionId) ? [] : [optionId]);
    this.setFieldValue(field.id, next.length ? { valueOptionIds: next } : null);
    if (!this.allowMultiple(field)) this.closePicker();
  }

  toggleFieldUser(field: AnyCustomField, userId: string): void {
    const current = this.userIdsFor(field.id);
    const next = this.allowMultiple(field)
      ? toggleId(current, userId)
      : (current.includes(userId) ? [] : [userId]);
    this.setFieldValue(field.id, next.length ? { valueUserIds: next } : null);
    if (!this.allowMultiple(field)) this.closePicker();
  }

  clearField(field: AnyCustomField): void {
    this.setFieldValue(field.id, null);
    this.closePicker();
  }

  // ─── Attachments ────────────────────────────────────────────────────────────

  protected readonly attachmentAccept = [
    ...Object.keys(ALLOWED_ATTACHMENT_MIME),
    ...ALLOWED_ATTACHMENT_EXTENSIONS.map((extension) => `.${extension}`),
  ].join(",");

  iconFor(file: File): string {
    return attachmentIconClass(file.type, file.name);
  }

  formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  onFilesChosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.stageFiles(input.files);
    // Reset so choosing the same file twice in a row still fires `change`.
    input.value = "";
  }

  removePendingAttachment(key: string): void {
    this.pendingAttachments.update((pending) => pending.filter((item) => item.key !== key));
  }

  onDragOver(event: DragEvent): void {
    if (!this.acceptsFileDrag(event.dataTransfer)) return;
    // Without preventDefault the browser navigates to the dropped file, which would abandon the
    // composer entirely.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    this.dragActive.set(true);
  }

  onDragLeave(event: DragEvent): void {
    // dragleave also fires when the pointer crosses between children of the overlay, so only clear
    // the highlight when the drag has actually left it.
    const next = event.relatedTarget as Node | null;
    if (next && (event.currentTarget as HTMLElement).contains(next)) return;
    this.dragActive.set(false);
  }

  onDrop(event: DragEvent): void {
    if (!this.acceptsFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    this.dragActive.set(false);
    this.stageFiles(event.dataTransfer?.files ?? null);
  }

  onPaste(event: ClipboardEvent): void {
    const files = clipboardFiles(event.clipboardData);
    if (files.length === 0) return;
    // The description editor is mounted with attachments off — it has no upload target before the
    // card exists — so it leaves file pastes alone and they bubble to here regardless of whether the
    // caret was in the title or the editor.
    event.preventDefault();
    this.stageFiles(files);
  }

  private acceptsFileDrag(data: DataTransfer | null): boolean {
    if (this.busy() || !this.canEdit() || !data) return false;
    return Array.from(data.types ?? []).some((type) => type === "Files" || type === "application/x-moz-file")
      || Array.from(data.items ?? []).some((item) => item.kind === "file");
  }

  private stageFiles(files: FileList | File[] | null): void {
    const incoming = Array.from(files ?? []);
    if (incoming.length === 0) return;
    // Type is the only limit the client can check. Per-file size is enforced server-side against the
    // board OWNER's tier, which this client cannot know, so an oversized file is only rejected on
    // upload — see DescriptionEditorUploader.validationError.
    const allowed = incoming.filter((file) => getAllowedAttachmentExtension(file.type, file.name) !== null);
    const skipped = incoming.length - allowed.length;
    this.attachmentError.set(skipped > 0 ? `${skipped} file${skipped === 1 ? "" : "s"} skipped — unsupported type.` : null);
    if (allowed.length === 0) return;
    this.pendingAttachments.update((pending) => [
      ...pending,
      ...allowed.map((file) => ({ key: crypto.randomUUID(), file })),
    ]);
  }

  /**
   * Uploads the staged files now that the card has an id, and returns the names that failed.
   *
   * Sequential rather than parallel: storage quota is checked per request against the host org's
   * pool, so a batch that crosses the limit fails from a known point instead of partially and at
   * random. Each success is dropped from the staged list as it lands, so a reported failure leaves
   * exactly the unsent files behind.
   */
  private async uploadPendingAttachments(cardId: string): Promise<string[]> {
    const failed: string[] = [];
    for (const item of this.pendingAttachments()) {
      try {
        const form = new FormData();
        form.append("file", item.file);
        await this.api.request(`/cards/${cardId}/attachments`, { method: "POST", body: form });
        this.removePendingAttachment(item.key);
      } catch {
        failed.push(item.file.name);
      }
    }
    return failed;
  }

  // ─── Draft + dismissal ──────────────────────────────────────────────────────

  discardDraft(): void {
    // Keep the board and list the composer was opened against: discarding a draft means clearing
    // what was typed, not moving the user out of the column they opened.
    const { listId, boardId } = this.draft();
    this.recoveredDraft.set(false);
    this.draft.set({ ...emptyComposerDraft(), boardId, listId });
    this.pendingAttachments.set([]);
    this.attachmentError.set(null);
    this.descriptionEditor()?.reset();
    writeComposerDraft(this.storageKey(), null);
  }

  /**
   * Cancel is an explicit discard action. Passive close routes still preserve a recoverable draft,
   * but choosing Cancel must not repopulate a later composer with people or properties the user
   * deliberately abandoned.
   */
  cancel(): void {
    if (this.busy()) return;
    this.discardDraft();
    this.dismissed.emit();
  }

  /**
   * Every close route goes through here. The typed draft is already persisted, so closing normally
   * costs nothing — but staged files cannot be persisted, so once any are waiting the close has to
   * be confirmed rather than silently discarding them.
   */
  requestDismiss(): void {
    if (this.busy()) return;
    if (!this.unsavedWork.confirm(this.pendingAttachments().length > 0)) return;
    this.dismissed.emit();
  }

  onBackdropClick(): void {
    this.requestDismiss();
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      // A picker consumes Escape first (its own panel handles dismissal); only close the dialog
      // when nothing is layered on top of it.
      if (this.openPicker()) return;
      event.stopPropagation();
      this.requestDismiss();
      return;
    }
    // Cmd/Ctrl+Enter submits from anywhere in the dialog, including the description textarea where a
    // bare Enter has to keep inserting newlines.
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void this.submit();
    }
  }

  // ─── Create ─────────────────────────────────────────────────────────────────

  /**
   * Creates the card, then applies the properties the create endpoint does not accept.
   *
   * The follow-up calls deliberately reuse the ordinary per-property endpoints instead of a widened
   * create body: each already records its own activity and emits its own realtime event, so a card
   * composed here produces exactly the same audit trail and client fanout as one built field by
   * field in card detail. The cost is that the card appears first and its properties land a moment
   * later — acceptable, and visible to every connected client in the same order.
   */
  async submit(event?: Event): Promise<void> {
    event?.preventDefault();
    if (!this.canSubmit()) return;
    const draft = this.draft();
    const listId = draft.listId || this.lists()[0]?.id;
    if (!listId) {
      this.error.set("This board's workspace has no lists yet.");
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    try {
      const card = await this.api.createCard<AnyCard>(`/boards/${this.boardId()}/lists/${listId}/cards`, {
        title: draft.title.trim(),
        clientToken: crypto.randomUUID(),
        ...(this.atTop() ? { atTop: true } : {}),
        // A description of only blank lines is dropped rather than saved: it would give the card a
        // description that renders as nothing.
        ...(hasMarkdownContent(draft.description) ? { description: draft.description.trim() } : {}),
        ...(draft.assigneeIds.length ? { assigneeIds: draft.assigneeIds } : {}),
      });
      this.notifications.watchCreatedCardLocally(card.id);
      // Publish the card before the property writes so the board paints the new tile immediately;
      // each follow-up emits its own event and the tile settles in place.
      this.created.emit(card);

      const failures = await this.applyProperties(card.id, draft);
      if (failures.length > 0) {
        this.error.set(`Card created, but ${failures.join(", ")} could not be applied. Open the card to fix ${failures.length === 1 ? "it" : "them"}.`);
        this.busy.set(false);
        return;
      }

      writeComposerDraft(this.storageKey(), null);
      this.recoveredDraft.set(false);
      if (this.createAnother()) {
        // Keep the column context (list plus whatever the column seeded) and clear only the content,
        // which is what makes a run of related cards fast to enter.
        this.draft.set({
          ...emptyComposerDraft(),
          boardId: this.boardId(),
          listId,
          labelIds: draft.labelIds,
          assigneeIds: draft.assigneeIds,
          dueDateLocalDate: draft.dueDateLocalDate,
          dueDateSlot: draft.dueDateSlot,
          customFields: draft.customFields,
          completed: draft.completed,
        });
        // The editor reads its initial value once, so clearing the draft is not enough to empty it.
        this.descriptionEditor()?.reset();
        this.attachmentError.set(null);
        this.busy.set(false);
        this.titleEl()?.nativeElement.focus();
        return;
      }
      this.dismissed.emit();
    } catch {
      this.error.set("We couldn’t create the card. Please try again.");
      this.busy.set(false);
    }
  }

  /** Returns the human names of the property groups that failed, so one bad write is reportable. */
  private async applyProperties(cardId: string, draft: CardComposerDraft): Promise<string[]> {
    const failures: string[] = [];
    const step = async (name: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch {
        failures.push(name);
      }
    };

    if (draft.labelIds.length) {
      await step("labels", () => this.api.put(`/cards/${cardId}/labels`, { labelIds: draft.labelIds }));
    }
    if (draft.dueDateLocalDate) {
      await step("the due date", () => this.api.patch(`/cards/${cardId}`, {
        dueDateLocalDate: draft.dueDateLocalDate,
        dueDateSlot: draft.dueDateSlot,
      }));
    }
    for (const [fieldId, value] of Object.entries(draft.customFields)) {
      const name = this.customFields().find((field) => field.id === fieldId)?.name ?? "a custom field";
      await step(name, () => this.api.put(`/cards/${cardId}/custom-fields/${fieldId}`, value));
    }
    if (draft.checklistTemplateIds.length) {
      await step("checklists", () => this.api.post(`/cards/${cardId}/checklist-templates/apply`, {
        templateIds: draft.checklistTemplateIds,
      }));
    }
    // Staged files flush here rather than in `submit` so an upload failure is reported through the
    // same "created, but…" path as every other property the create body could not carry.
    const failedUploads = await this.uploadPendingAttachments(cardId);
    if (failedUploads.length > 0) {
      failures.push(failedUploads.length === 1 ? `the attachment ${failedUploads[0]}` : `${failedUploads.length} attachments`);
    }
    // Completion is applied last: a card seeded from a "Completed" column should only flip once its
    // content is in place, so watchers do not receive a completion notification for an empty card.
    if (draft.completed) {
      await step("completion", () => this.api.patch(`/cards/${cardId}/completion`, { completed: true }));
    }
    return failures;
  }
}

/**
 * Files on a clipboard payload. `items` is the reliable source for a screenshot paste (where
 * `files` is empty in some browsers); `files` is the fallback for a copied file from the OS.
 */
function clipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems = Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  return fromItems.length > 0 ? fromItems : Array.from(data.files ?? []);
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id];
}

function mergeIds(current: string[], extra: string[]): string[] {
  return [...new Set([...current, ...extra])];
}
