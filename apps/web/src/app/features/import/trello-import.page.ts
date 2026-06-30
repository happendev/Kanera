import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import type { ColorToken } from "@kanera/shared/colors";
import type { AnalyzeImportResponse, AnalyzeKaneraBoardImportResponse, CommitImportBody, CustomFieldTypeName, ImportResultSummary, KaneraBoardImportManifest, TrelloImportManifest } from "@kanera/shared/dto";
import { CARD_LABEL_NAME_MAX_LENGTH, WORKSPACE_ENTITY_NAME_MAX_LENGTH } from "@kanera/shared/dto/name-limits";
import type { WireCardLabel, WireCustomField } from "@kanera/shared/events";
import type { List, WorkspaceMember } from "@kanera/shared/schema";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { ColorPickerComponent } from "../../shared/color-picker.component";
import { IconPickerComponent } from "../../shared/icon-picker.component";
import { findMatchingImportMember } from "./import-member-mapping.util";

type MemberRow = WorkspaceMember & { email: string; displayName: string; avatarUrl: string | null };
type Step = "upload" | "lists" | "labels" | "fields" | "members" | "options" | "result";
type Action = "create" | "map" | "skip";
type ImportSource = "trello" | "kanera";
type ImportManifest = TrelloImportManifest | KaneraBoardImportManifest;
type ListMapping = { action: Action; targetListId?: string; name: string; icon: string | null; color: ColorToken | null };
type LabelMapping = { action: Action; targetLabelId?: string; name: string; color: ColorToken | null };
type FieldMapping = { action: Action; targetFieldId?: string; name: string; type: CustomFieldTypeName; icon: string };
type CommitListMapping = CommitImportBody["lists"][string];
type CommitLabelMapping = CommitImportBody["labels"][string];
type CommitFieldMapping = CommitImportBody["customFields"][string];

const STEPS: Step[] = ["upload", "lists", "labels", "fields", "members", "options", "result"];
const cappedName = (value: string, maxLength: number) => value.trim().slice(0, maxLength);
const STEP_COPY: Record<Step, { title: string; description: string }> = {
  upload: {
    title: "Upload Export",
    description: "Choose a JSON export so Kanera can inspect the board before anything is created.",
  },
  lists: {
    title: "Mapping Lists",
    description: "Lists are shared across every board in this workspace. Create new lists, reuse matching workspace lists, or skip lists and their cards.",
  },
  labels: {
    title: "Mapping Labels",
    description: "Choose whether Trello labels become new workspace labels, reuse existing labels, or are left off imported cards.",
  },
  fields: {
    title: "Mapping Custom Fields",
    description: "Custom fields are workspace-wide in Kanera, so mapped fields must use a compatible type before values can be imported.",
  },
  members: {
    title: "Mapping Members",
    description: "Assign source members to workspace members. Unmapped members are imported as unassigned cards and attributed comments.",
  },
  options: {
    title: "Review Options",
    description: "Name the new board and choose optional source data.",
  },
  result: {
    title: "Import Complete",
    description: "The Trello board has been imported into a new Kanera board.",
  },
};

const SOURCE_COPY: Record<ImportSource, { title: string; hint: string; upload: string; fileError: string; importComplete: string; preservedAttachments: string }> = {
  trello: {
    title: "Trello import",
    hint: "Import a Trello JSON export into a new Kanera board.",
    upload: "Choose a Trello JSON export",
    fileError: "Choose a Trello JSON export first.",
    importComplete: "The Trello board has been imported into a new Kanera board.",
    preservedAttachments: "attachment links will be preserved",
  },
  kanera: {
    title: "Kanera board import",
    hint: "Import a Kanera board JSON export into a new board in this workspace.",
    upload: "Choose a Kanera board JSON export",
    fileError: "Choose a Kanera board JSON export first.",
    importComplete: "The Kanera board has been imported into a new board.",
    preservedAttachments: "attachments will be copied when possible",
  },
};

@Component({
  selector: "k-trello-import",
  standalone: true,
  imports: [RouterLink, IconPickerComponent, ColorPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./trello-import.page.html",
  styleUrl: "./trello-import.page.scss",
})
export class TrelloImportPage {
  private readonly api = inject(ApiClient);

  readonly workspaceId = input.required<string>();
  readonly source = input<ImportSource>("trello");
  readonly lists = input<List[]>([]);
  readonly labels = input<WireCardLabel[]>([]);
  readonly fields = input<WireCustomField[]>([]);
  readonly members = input<MemberRow[]>([]);

  readonly step = signal<Step>("upload");
  readonly importId = signal<string | null>(null);
  readonly manifest = signal<ImportManifest | null>(null);
  readonly fileName = signal<string | null>(null);
  readonly selectedFile = signal<File | null>(null);
  readonly uploadDragActive = signal(false);
  readonly boardName = signal("");
  readonly boardIcon = signal("layout-kanban");
  readonly boardIconColor = signal<ColorToken | null>(null);
  readonly boardVisibility = signal<"workspace" | "private">("workspace");
  readonly listMappings = signal<Record<string, ListMapping>>({});
  readonly labelMappings = signal<Record<string, LabelMapping>>({});
  readonly fieldMappings = signal<Record<string, FieldMapping>>({});
  readonly memberMappings = signal<Record<string, string | null>>({});
  readonly includeArchived = signal(false);
  readonly importComments = signal(true);
  readonly importCustomFields = signal(true);
  readonly busy = signal(false);
  readonly slowImport = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<ImportResultSummary | null>(null);

  readonly steps = STEPS;
  readonly workspaceEntityNameMaxLength = WORKSPACE_ENTITY_NAME_MAX_LENGTH;
  readonly labelNameMaxLength = CARD_LABEL_NAME_MAX_LENGTH;
  readonly sourceCopy = computed(() => SOURCE_COPY[this.source()]);
  readonly stepIndex = computed(() => STEPS.indexOf(this.step()));
  readonly stepTitle = computed(() => `Step ${this.stepIndex() + 1} - ${STEP_COPY[this.step()].title}`);
  readonly stepDescription = computed(() => this.step() === "result" ? this.sourceCopy().importComplete : STEP_COPY[this.step()].description);
  readonly skippedCardCount = computed(() => {
    const manifest = this.manifest();
    if (!manifest) return 0;
    const mappings = this.listMappings();
    return manifest.lists.reduce((sum, list) => sum + (mappings[list.id]?.action === "skip" ? list.cardCount : 0), 0);
  });
  readonly incompatibleFieldMaps = computed(() => {
    const mappings = this.fieldMappings();
    return this.manifest()?.customFields.filter((field) => {
      const mapping = mappings[field.id];
      if (!mapping || mapping.action !== "map") return false;
      const target = this.fields().find((candidate) => candidate.id === mapping.targetFieldId);
      return !!target && target.type !== field.suggestedType;
    }) ?? [];
  });

  async analyze(event: Event) {
    event.preventDefault();
    const file = this.selectedFile();
    if (!file) {
      this.error.set(this.sourceCopy().fileError);
      return;
    }
    const form = new FormData();
    form.set("file", file);
    this.busy.set(true);
    this.slowImport.set(false);
    this.error.set(null);
    try {
      const endpoint = this.source() === "kanera" ? "kanera-board" : "trello";
      const response = await this.api.request<AnalyzeImportResponse | AnalyzeKaneraBoardImportResponse>(`/workspaces/${this.workspaceId()}/imports/${endpoint}/analyze`, {
        method: "POST",
        body: form,
      });
      this.fileName.set(file.name);
      this.importId.set(response.importId);
      this.manifest.set(response.manifest);
      this.boardName.set(cappedName(response.manifest.board.name, WORKSPACE_ENTITY_NAME_MAX_LENGTH));
      this.boardIcon.set("icon" in response.manifest.board ? response.manifest.board.icon ?? "layout-kanban" : "layout-kanban");
      this.boardIconColor.set("iconColor" in response.manifest.board ? response.manifest.board.iconColor ?? null : null);
      this.boardVisibility.set("visibility" in response.manifest.board ? response.manifest.board.visibility : "workspace");
      this.includeArchived.set(this.source() === "kanera");
      const members = this.members().length
        ? this.members()
        : await this.api.get<MemberRow[]>(`/workspaces/${this.workspaceId()}/members`);
      this.initializeMappings(response.manifest, members);
      this.step.set("lists");
    } catch (error) {
      this.error.set(this.describeError(error));
    } finally {
      this.busy.set(false);
      this.slowImport.set(false);
    }
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    this.setSelectedFile(input.files?.[0] ?? null);
  }

  onUploadDragEnter(event: DragEvent) {
    if (!this.eventHasFiles(event)) return;
    event.preventDefault();
    this.uploadDragActive.set(true);
  }

  onUploadDragOver(event: DragEvent) {
    if (!this.eventHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    this.uploadDragActive.set(true);
  }

  onUploadDragLeave(event: DragEvent) {
    event.preventDefault();
    const current = event.currentTarget as HTMLElement | null;
    if (!current?.contains(event.relatedTarget as Node | null)) this.uploadDragActive.set(false);
  }

  onUploadDrop(event: DragEvent) {
    if (!this.eventHasFiles(event)) return;
    event.preventDefault();
    this.uploadDragActive.set(false);
    this.setSelectedFile(event.dataTransfer?.files?.[0] ?? null);
  }

  setStep(step: Step) {
    if (!this.manifest() && step !== "upload") return;
    if (step === "result" && !this.result()) return;
    this.error.set(null);
    this.step.set(step);
  }

  next() {
    const index = this.stepIndex();
    if (index >= 0 && index < STEPS.length - 2) this.step.set(STEPS[index + 1]!);
  }

  previous() {
    const index = this.stepIndex();
    if (index > 1) this.step.set(STEPS[index - 1]!);
    else this.step.set("upload");
  }

  setListAction(id: string, action: Action) {
    this.listMappings.update((all) => ({ ...all, [id]: { ...all[id]!, action } }));
  }

  updateList(id: string, patch: Partial<ListMapping>) {
    this.listMappings.update((all) => ({ ...all, [id]: { ...all[id]!, ...patch } }));
  }

  setLabelAction(id: string, action: Action) {
    this.labelMappings.update((all) => ({ ...all, [id]: { ...all[id]!, action } }));
  }

  updateLabel(id: string, patch: Partial<LabelMapping>) {
    this.labelMappings.update((all) => ({ ...all, [id]: { ...all[id]!, ...patch } }));
  }

  setFieldAction(id: string, action: Action) {
    this.fieldMappings.update((all) => ({ ...all, [id]: { ...all[id]!, action } }));
  }

  updateField(id: string, patch: Partial<FieldMapping>) {
    this.fieldMappings.update((all) => ({ ...all, [id]: { ...all[id]!, ...patch } }));
  }

  updateMember(id: string, userId: string) {
    this.memberMappings.update((all) => ({ ...all, [id]: userId || null }));
  }

  async commit() {
    const importId = this.importId();
    const manifest = this.manifest();
    if (!importId || !manifest) return;
    if (!this.boardName().trim()) {
      this.error.set("Enter a board name before importing.");
      return;
    }
    const incompatible = this.incompatibleFieldMaps();
    if (incompatible.length) {
      this.error.set("Mapped custom fields must use compatible field types.");
      this.step.set("fields");
      return;
    }
    this.busy.set(true);
    this.slowImport.set(false);
    this.error.set(null);
    const slowTimer = window.setTimeout(() => {
      if (this.busy()) this.slowImport.set(true);
    }, 30_000);
    try {
      const body = this.buildCommitBody();
      const endpoint = this.source() === "kanera" ? `/imports/kanera-board/${importId}/commit` : `/imports/${importId}/commit`;
      const result = await this.api.post<ImportResultSummary>(endpoint, body);
      this.result.set(result);
      this.step.set("result");
    } catch (error) {
      this.error.set(this.describeError(error));
    } finally {
      window.clearTimeout(slowTimer);
      this.busy.set(false);
      this.slowImport.set(false);
    }
  }

  private initializeMappings(manifest: ImportManifest, existingMembers = this.members()) {
    const existingLists = this.lists();
    const existingLabels = this.labels();
    const existingFields = this.fields();
    this.listMappings.set(Object.fromEntries(manifest.lists.map((list) => {
      const target = existingLists.find((candidate) => candidate.name.toLowerCase() === list.name.toLowerCase());
      return [list.id, {
        action: this.source() === "trello" && list.closed ? "skip" : target ? "map" : "create",
        targetListId: target?.id,
        name: cappedName(list.name, WORKSPACE_ENTITY_NAME_MAX_LENGTH),
        icon: "list",
        color: null,
      } satisfies ListMapping];
    })));
    this.labelMappings.set(Object.fromEntries(manifest.labels.map((label) => {
      const target = existingLabels.find((candidate) => candidate.name.toLowerCase() === label.name.toLowerCase());
      return [label.id, {
        action: target ? "map" : "create",
        targetLabelId: target?.id,
        name: cappedName(label.name || "Imported label", CARD_LABEL_NAME_MAX_LENGTH),
        color: label.suggestedToken,
      } satisfies LabelMapping];
    })));
    this.fieldMappings.set(Object.fromEntries(manifest.customFields.map((field) => {
      const target = existingFields.find((candidate) => candidate.name.toLowerCase() === field.name.toLowerCase() && candidate.type === field.suggestedType);
      return [field.id, {
        action: target ? "map" : "create",
        targetFieldId: target?.id,
        name: cappedName(field.name, WORKSPACE_ENTITY_NAME_MAX_LENGTH),
        type: field.suggestedType,
        icon: "forms",
      } satisfies FieldMapping];
    })));
    this.memberMappings.set(Object.fromEntries(manifest.members.map((member) => {
      const target = findMatchingImportMember(member, existingMembers);
      return [member.id, target?.userId ?? null];
    })));
  }

  private setSelectedFile(file: File | null) {
    this.error.set(null);
    if (!file) {
      this.selectedFile.set(null);
      this.fileName.set(null);
      return;
    }
    this.selectedFile.set(file);
    this.fileName.set(file.name);
  }

  private eventHasFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  private buildCommitBody(): CommitImportBody {
    const lists: Record<string, CommitListMapping> = {};
    for (const [id, mapping] of Object.entries(this.listMappings())) {
      if (mapping.action === "map") lists[id] = { action: "map", targetListId: mapping.targetListId! };
      else if (mapping.action === "skip") lists[id] = { action: "skip" };
      else lists[id] = { action: "create", name: cappedName(mapping.name, WORKSPACE_ENTITY_NAME_MAX_LENGTH), icon: mapping.icon, color: mapping.color };
    }
    const labels: Record<string, CommitLabelMapping> = {};
    for (const [id, mapping] of Object.entries(this.labelMappings())) {
      if (mapping.action === "map") labels[id] = { action: "map", targetLabelId: mapping.targetLabelId! };
      else if (mapping.action === "skip") labels[id] = { action: "skip" };
      else labels[id] = { action: "create", name: cappedName(mapping.name, CARD_LABEL_NAME_MAX_LENGTH), color: mapping.color };
    }
    const customFields: Record<string, CommitFieldMapping> = {};
    for (const [id, mapping] of Object.entries(this.fieldMappings())) {
      if (mapping.action === "map") customFields[id] = { action: "map", targetFieldId: mapping.targetFieldId! };
      else if (mapping.action === "skip") customFields[id] = { action: "skip" };
      else customFields[id] = { action: "create", name: cappedName(mapping.name, WORKSPACE_ENTITY_NAME_MAX_LENGTH), type: mapping.type, icon: mapping.icon };
    }
    return {
      board: {
        name: cappedName(this.boardName(), WORKSPACE_ENTITY_NAME_MAX_LENGTH),
        icon: this.boardIcon(),
        iconColor: this.boardIconColor(),
        visibility: this.boardVisibility(),
      },
      lists,
      labels,
      customFields,
      members: this.memberMappings(),
      options: {
        includeArchived: this.includeArchived(),
        importComments: this.importComments(),
        importCustomFields: this.importCustomFields(),
        attachmentCopyMode: this.source() === "kanera" ? "copy" : "skip",
      },
    };
  }

  private describeError(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.status === 413) return `That ${this.source() === "kanera" ? "Kanera board" : "Trello"} export is over the 50MB import limit.`;
      const body = error.body as { message?: string } | undefined;
      return body?.message ?? `Import failed with status ${error.status}.`;
    }
    return error instanceof Error ? error.message : "Import failed. Try again.";
  }
}
