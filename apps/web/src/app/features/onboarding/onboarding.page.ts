import type { CdkDragDrop} from "@angular/cdk/drag-drop";
import { CdkDrag, CdkDropList, moveItemInArray } from "@angular/cdk/drag-drop";
import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from "@angular/core";
import { Router } from "@angular/router";
import type { ColorToken } from "@kanera/shared/colors";
import type { CustomFieldTypeName } from "@kanera/shared/dto";
import { CARD_LABEL_NAME_MAX_LENGTH, WORKSPACE_ENTITY_NAME_MAX_LENGTH } from "@kanera/shared/dto/name-limits";
import type { Board, Workspace } from "@kanera/shared/schema";
import { DEFAULT_WORKSPACE_TEMPLATE, WORKSPACE_TEMPLATES } from "@kanera/shared/workspace-templates";
import type { WorkspaceTemplate, WorkspaceTemplateId } from "@kanera/shared/workspace-templates";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { SocketService } from "../../core/realtime/socket.service";
import { ColorPickerComponent } from "../../shared/color-picker.component";
import { IconPickerComponent } from "../../shared/icon-picker.component";
import { LogoComponent } from "../../shared/logo.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { standaloneBoardCreatePayload, workspaceTemplateSeedPayload } from "../standalone-board/standalone-board-create.payload";

interface DraftItem {
  id: string;
  name: string;
  icon?: string;
  type?: CustomFieldTypeName;
  allowMultiple?: boolean;
  options?: DraftFieldOption[];
}

interface DraftFieldOption {
  id: string;
  label: string;
  color?: ColorToken | null;
}

interface DraftLabel {
  name: string;
  color: ColorToken | null;
}

type OnboardingWorkspaceResponse = Workspace & { initialBoard?: Board };
type OnboardingStandaloneBoardResponse = Workspace & { initialBoard: Board };
type OnboardingHomeResponse = { groups: { boards: unknown[] }[] };
type SetupKind = "choice" | "board" | "workspace";

const normalizeCustomFieldName = (name: string) => name.trim().toLocaleLowerCase();
const draftId = (prefix: string, index: number) => `${prefix}-${index + 1}`;
const draftListsFromTemplate = (template: WorkspaceTemplate): DraftItem[] => template.lists.map((list, index) => ({
  ...list,
  id: draftId(`${template.id}-list`, index),
}));
const draftFieldsFromTemplate = (template: WorkspaceTemplate): DraftItem[] => template.customFields.map((field, index) => ({
  ...field,
  id: draftId(`${template.id}-field`, index),
  options: field.options?.map((option, optionIndex) => ({ ...option, id: draftId(`${template.id}-field-${index + 1}-option`, optionIndex) })),
}));
const draftLabelsFromTemplate = (template: WorkspaceTemplate): DraftLabel[] => template.labels.map((label) => ({ ...label }));

@Component({
  selector: "k-onboarding",
  standalone: true,
  imports: [CdkDropList, CdkDrag, LogoComponent, IconPickerComponent, ColorPickerComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./onboarding.page.html",
  styleUrl: "./onboarding.page.scss",
})
export class OnboardingPage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly sockets = inject(SocketService);
  private draftSequence = 0;

  readonly mode = input<string | undefined>();
  // Existing workspace owners arrive here from an explicit "New workspace" action. Only an empty
  // account starts with the product-model choice, avoiding an extra click in the established flow.
  readonly setupKind = signal<SetupKind>(this.auth.user()?.hasWorkspace ? "workspace" : "choice");

  ngOnInit() {
    // Onboarding lives outside the app shell, so nothing else establishes the
    // socket here. Without a connection the offline guard in ApiClient flips to
    // "offline" after the debounce window and blocks the workspace-creation POST.
    this.sockets.connect();
    if (this.mode() === "workspace") this.setupKind.set("workspace");
    void this.refreshBoardHeadroom();
  }

  readonly templates = WORKSPACE_TEMPLATES;
  readonly step = signal<1 | 2 | 3 | 4 | 5 | 6>(1);
  readonly selectedTemplateId = signal<WorkspaceTemplateId>(DEFAULT_WORKSPACE_TEMPLATE.id);
  readonly boardTemplateId = signal<WorkspaceTemplateId>(DEFAULT_WORKSPACE_TEMPLATE.id);
  readonly selectedBoardTemplate = computed(() => this.templateById(this.boardTemplateId()));
  readonly boardIcon = signal(DEFAULT_WORKSPACE_TEMPLATE.icon);
  readonly boardIconColor = signal<ColorToken | null>(null);
  readonly hasEditedBoardIcon = signal(false);
  readonly boardName = signal("");
  readonly name = signal(DEFAULT_WORKSPACE_TEMPLATE.workspaceName);
  readonly icon = signal(DEFAULT_WORKSPACE_TEMPLATE.icon);
  readonly hasEditedWorkspaceIdentity = signal(false);
  readonly lists = signal<DraftItem[]>(draftListsFromTemplate(DEFAULT_WORKSPACE_TEMPLATE));
  readonly fields = signal<DraftItem[]>(draftFieldsFromTemplate(DEFAULT_WORKSPACE_TEMPLATE));
  readonly labels = signal<DraftLabel[]>(draftLabelsFromTemplate(DEFAULT_WORKSPACE_TEMPLATE));
  readonly boardCount = signal(0);
  readonly boardHeadroomLoaded = signal(false);
  readonly newList = signal("");
  readonly newField = signal("");
  readonly newFieldIcon = signal("forms");
  readonly newFieldType = signal<CustomFieldTypeName>("text");
  readonly newFieldAllowMultiple = signal(false);
  readonly editingFieldId = signal<string | null>(null);
  readonly editingFieldName = signal("");
  readonly newOptionLabel = signal<Record<string, string>>({});
  readonly newOptionColor = signal<Record<string, ColorToken | null>>({});
  readonly newLabel = signal("");
  readonly newLabelColor = signal<ColorToken | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly canCancel = computed(() => !!this.auth.user()?.hasWorkspace);
  readonly canReturnToSetupChoice = computed(() => !this.auth.user()?.hasWorkspace && this.mode() !== "workspace");
  readonly brandTitle = computed(() => {
    if (this.setupKind() === "choice") return "Get started";
    return this.setupKind() === "board" ? "Create a Board" : "Create a Workspace";
  });
  readonly createsInitialBoard = computed(() => this.selectedTemplateId() !== "blank");
  readonly boardLimitReached = computed(() => {
    const max = this.auth.maxBoards();
    return max !== null && this.boardCount() >= max;
  });
  readonly boardLimitMessage = computed(() => {
    const max = this.auth.maxBoards();
    return max === null
      ? "Your plan's board limit has been reached. Upgrade to add more."
      : `Your plan allows ${max} board${max === 1 ? "" : "s"}. Upgrade your plan to finish onboarding.`;
  });
  readonly isBlankTemplate = computed(() => this.selectedTemplateId() === "blank");
  readonly canUseOnboarding = computed(() => this.boardHeadroomLoaded() && (!this.createsInitialBoard() || !this.boardLimitReached()));
  readonly canCreateStandaloneBoard = computed(() => this.boardHeadroomLoaded() && !this.boardLimitReached() && !!this.boardName().trim());
  readonly canContinueFromLists = computed(() => this.isBlankTemplate() || this.lists().length >= 2);
  readonly workspaceEntityNameMaxLength = WORKSPACE_ENTITY_NAME_MAX_LENGTH;
  readonly labelNameMaxLength = CARD_LABEL_NAME_MAX_LENGTH;
  readonly customFieldValidation = computed(() => {
    const name = this.newField().trim();
    if (!name) return null;
    return this.hasDuplicateFieldName(name) ? "Custom field names must be unique within a workspace." : null;
  });

  chooseSetupKind(kind: Exclude<SetupKind, "choice">) {
    this.error.set(null);
    this.setupKind.set(kind);
  }

  returnToSetupChoice() {
    if (!this.canReturnToSetupChoice()) return;
    this.error.set(null);
    this.setupKind.set("choice");
  }

  selectBoardTemplate(templateId: WorkspaceTemplateId) {
    this.error.set(null);
    const template = this.templateById(templateId);
    this.boardTemplateId.set(template.id);
    if (!this.hasEditedBoardIcon()) this.boardIcon.set(template.icon);
  }

  setBoardIcon(icon: string) {
    this.hasEditedBoardIcon.set(true);
    this.boardIcon.set(icon);
  }

  setBoardIconColor(color: ColorToken | null) {
    this.boardIconColor.set(color);
  }

  selectTemplate(templateId: WorkspaceTemplateId) {
    this.error.set(null);
    const template = this.templateById(templateId);
    this.selectedTemplateId.set(template.id);
    this.lists.set(draftListsFromTemplate(template));
    this.fields.set(draftFieldsFromTemplate(template));
    this.labels.set(draftLabelsFromTemplate(template));
    if (!this.hasEditedWorkspaceIdentity()) {
      this.name.set(template.workspaceName);
      this.icon.set(template.icon);
    }
  }

  setWorkspaceName(value: string) {
    this.hasEditedWorkspaceIdentity.set(true);
    this.name.set(value);
  }

  setWorkspaceIcon(value: string) {
    this.hasEditedWorkspaceIdentity.set(true);
    this.icon.set(value);
  }

  addList() {
    this.error.set(null);
    if (this.createsInitialBoard() && this.boardLimitReached()) {
      this.error.set(this.boardLimitMessage());
      return;
    }
    const name = this.newList().trim();
    if (!name) return;
    this.lists.update((items) => [...items, { id: this.nextDraftId("list"), name }]);
    this.newList.set("");
  }

  removeList(index: number) {
    this.error.set(null);
    this.lists.update((items) => items.filter((_, itemIndex) => itemIndex !== index));
  }

  addField() {
    this.error.set(null);
    const name = this.newField().trim();
    if (!name) return;
    if (this.hasDuplicateFieldName(name)) return;
    const type = this.newFieldType();
    const supportsMultiple = type === "select" || type === "user";
    this.fields.update((items) => [...items, {
      id: this.nextDraftId("field"),
      name,
      icon: this.newFieldIcon(),
      type,
      allowMultiple: supportsMultiple ? this.newFieldAllowMultiple() : false,
      options: type === "select" ? [] : undefined,
    }]);
    this.newField.set("");
    this.newFieldIcon.set("forms");
    this.newFieldType.set("text");
    this.newFieldAllowMultiple.set(false);
  }

  removeField(index: number) {
    this.error.set(null);
    this.fields.update((items) => items.filter((_, itemIndex) => itemIndex !== index));
  }

  setFieldIcon(index: number, icon: string) {
    this.error.set(null);
    this.fields.update((items) => items.map((field, itemIndex) => (itemIndex === index ? { ...field, icon } : field)));
  }

  startEditField(field: DraftItem) {
    this.editingFieldId.set(field.id);
    this.editingFieldName.set(field.name);
  }

  cancelEditField() {
    this.editingFieldId.set(null);
  }

  saveFieldName(fieldId: string) {
    const name = this.editingFieldName().trim();
    this.editingFieldId.set(null);
    if (!name) return;
    const current = this.fields().find((field) => field.id === fieldId);
    if (!current || current.name === name) return;
    if (this.fields().some((field) => field.id !== fieldId && normalizeCustomFieldName(field.name) === normalizeCustomFieldName(name))) {
      this.error.set("Custom field names must be unique within a workspace.");
      return;
    }
    this.error.set(null);
    this.fields.update((items) => items.map((field) => (field.id === fieldId ? { ...field, name } : field)));
  }

  toggleFieldAllowMultiple(fieldId: string) {
    this.error.set(null);
    this.fields.update((items) =>
      items.map((field) =>
        field.id === fieldId && (field.type === "select" || field.type === "user")
          ? { ...field, allowMultiple: !field.allowMultiple }
          : field,
      ),
    );
  }

  optionDraft(fieldId: string): string {
    return this.newOptionLabel()[fieldId] ?? "";
  }

  setNewOptionLabel(fieldId: string, value: string) {
    this.newOptionLabel.update((map) => ({ ...map, [fieldId]: value }));
  }

  optionDraftColor(fieldId: string): ColorToken | null {
    return this.newOptionColor()[fieldId] ?? null;
  }

  setNewOptionColor(fieldId: string, value: ColorToken | null) {
    this.newOptionColor.update((map) => ({ ...map, [fieldId]: value }));
  }

  addOption(fieldId: string) {
    const label = this.optionDraft(fieldId).trim();
    if (!label) return;
    this.fields.update((items) =>
      items.map((field) =>
        field.id === fieldId
          ? { ...field, options: [...(field.options ?? []), { id: this.nextDraftId("option"), label, color: this.optionDraftColor(fieldId) }] }
          : field,
      ),
    );
    this.setNewOptionLabel(fieldId, "");
    this.setNewOptionColor(fieldId, null);
  }

  renameOption(fieldId: string, optionId: string, label: string) {
    const trimmed = label.trim();
    if (!trimmed) return;
    this.fields.update((items) =>
      items.map((field) =>
        field.id === fieldId
          ? { ...field, options: (field.options ?? []).map((option) => (option.id === optionId ? { ...option, label: trimmed } : option)) }
          : field,
      ),
    );
  }

  recolorOption(fieldId: string, optionId: string, color: ColorToken | null) {
    this.fields.update((items) =>
      items.map((field) =>
        field.id === fieldId
          ? { ...field, options: (field.options ?? []).map((option) => (option.id === optionId ? { ...option, color } : option)) }
          : field,
      ),
    );
  }

  deleteOption(fieldId: string, optionId: string) {
    this.fields.update((items) =>
      items.map((field) =>
        field.id === fieldId
          ? { ...field, options: (field.options ?? []).filter((option) => option.id !== optionId) }
          : field,
      ),
    );
  }

  dropOption(fieldId: string, event: CdkDragDrop<DraftFieldOption[]>) {
    if (event.previousIndex === event.currentIndex) return;
    this.fields.update((items) =>
      items.map((field) => {
        if (field.id !== fieldId) return field;
        const options = [...(field.options ?? [])];
        moveItemInArray(options, event.previousIndex, event.currentIndex);
        return { ...field, options };
      }),
    );
  }

  dropList(event: CdkDragDrop<DraftItem[]>) {
    this.lists.update((items) => {
      const next = [...items];
      moveItemInArray(next, event.previousIndex, event.currentIndex);
      return next;
    });
  }

  dropField(event: CdkDragDrop<DraftItem[]>) {
    this.fields.update((items) => {
      const next = [...items];
      moveItemInArray(next, event.previousIndex, event.currentIndex);
      return next;
    });
  }

  addLabel() {
    this.error.set(null);
    const name = this.newLabel().trim();
    if (!name) return;
    this.labels.update((items) => [...items, { name, color: this.newLabelColor() }]);
    this.newLabel.set("");
  }

  removeLabel(index: number) {
    this.error.set(null);
    this.labels.update((items) => items.filter((_, itemIndex) => itemIndex !== index));
  }

  dropLabel(event: CdkDragDrop<DraftLabel[]>) {
    this.labels.update((items) => {
      const next = [...items];
      moveItemInArray(next, event.previousIndex, event.currentIndex);
      return next;
    });
  }

  setLabelColor(index: number, color: ColorToken | null) {
    this.error.set(null);
    this.labels.update((items) => items.map((label, i) => (i === index ? { ...label, color } : label)));
  }

  private hasDuplicateFieldName(name: string) {
    const normalizedName = normalizeCustomFieldName(name);
    return this.fields().some((field) => normalizeCustomFieldName(field.name) === normalizedName);
  }

  continueFromLists() {
    if (!this.canUseOnboarding()) {
      this.error.set(this.boardLimitMessage());
      return;
    }
    if (!this.canContinueFromLists()) return;
    this.error.set(null);
    this.step.set(5);
  }

  async cancel() {
    if (this.busy()) return;
    await this.router.navigateByUrl("/");
  }

  async finishStandaloneBoard() {
    await this.refreshBoardHeadroom();
    if (this.boardLimitReached()) {
      this.error.set(this.boardLimitMessage());
      return;
    }
    if (!this.auth.isOrgAdmin()) {
      await this.router.navigateByUrl("/");
      return;
    }
    const name = this.boardName().trim();
    if (!name) {
      this.error.set("Enter a board name before finishing setup.");
      return;
    }
    const template = this.templateById(this.boardTemplateId());
    this.busy.set(true);
    this.error.set(null);
    try {
      const created = await this.api.post<OnboardingStandaloneBoardResponse>(
        "/workspaces",
        standaloneBoardCreatePayload(name, template, {
          icon: this.boardIcon(),
          iconColor: this.boardIconColor(),
        }),
      );
      // A standalone board intentionally does not satisfy hasWorkspace; the shell guard resolves
      // its board access from /home/boards on this navigation and on future sign-ins.
      await this.router.navigateByUrl(`/b/${created.initialBoard.id}`, { replaceUrl: true });
    } catch (error) {
      if (error instanceof ApiError && this.isPlanLimitError(error.body)) this.markBoardLimitReached();
      this.error.set(this.describeStandaloneBoardError(error));
    } finally {
      this.busy.set(false);
    }
  }

  async finish() {
    await this.refreshBoardHeadroom();
    const createsInitialBoard = this.createsInitialBoard();
    if (createsInitialBoard && this.boardLimitReached()) {
      this.error.set(this.boardLimitMessage());
      return;
    }
    if (!this.auth.isOrgAdmin()) {
      await this.router.navigateByUrl("/");
      return;
    }
    const name = this.name().trim();
    if (!name) {
      this.error.set("Enter a workspace name before finishing setup.");
      this.step.set(3);
      return;
    }
    const template = this.templateById(this.selectedTemplateId());
    this.busy.set(true);
    this.error.set(null);
    try {
      const workspace = await this.api.post<OnboardingWorkspaceResponse>("/workspaces", {
        name,
        icon: this.icon(),
        ...(createsInitialBoard ? {
          initialBoard: {
            name: template.initialBoardName,
            icon: template.icon,
          },
        } : {}),
        lists: this.lists().map((list) => ({ name: list.name.trim(), icon: list.icon ?? null })),
        customFields: this.fields().map((field) => ({
          name: field.name.trim(),
          icon: field.icon ?? "forms",
          type: field.type ?? "text",
          allowMultiple: field.allowMultiple ?? false,
          ...(field.type === "select" && field.options?.length
            ? { options: field.options.map((option) => ({ label: option.label, color: option.color })) }
            : {}),
        })),
        labels: this.labels().map((label) => ({ name: label.name.trim(), color: label.color })),
        ...workspaceTemplateSeedPayload(
          template,
          this.lists().map((list) => list.name),
          this.labels().map((label) => label.name),
          this.fields().map((field) => ({
            name: field.name,
            options: field.options?.map((option) => option.label) ?? [],
          })),
        ),
      });
      if (!this.auth.user()?.hasWorkspace) {
        this.auth.updateUser((user) => ({ ...user, hasWorkspace: true }));
      }
      await this.router.navigateByUrl(workspace.initialBoard ? `/b/${workspace.initialBoard.id}` : "/", { replaceUrl: true });
    } catch (error) {
      if (error instanceof ApiError && this.isPlanLimitError(error.body)) this.markBoardLimitReached();
      this.error.set(this.describeError(error));
    } finally {
      this.busy.set(false);
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.status === 0) return "You're offline. Reconnect and try again.";
      if (this.isPlanLimitError(error.body)) return this.boardLimitMessage();
      const message = this.messageFromBody(error.body);
      if (message) return message;
      if (error.status === 401) return "Your session expired. Sign in again to finish setup.";
      if (error.status === 403) return "Only organisation admins can finish workspace setup.";
      return `Setup failed with status ${error.status}. Try again.`;
    }
    if (error instanceof Error && error.message) return error.message;
    return "Setup failed. Try again.";
  }

  private describeStandaloneBoardError(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.status === 0) return "You're offline. Reconnect and try again.";
      if (this.isPlanLimitError(error.body)) return this.boardLimitMessage();
      const message = this.messageFromBody(error.body);
      if (message) return message;
      if (error.status === 401) return "Your session expired. Sign in again to create the board.";
      if (error.status === 403) return "Only organisation admins can create boards.";
      return `Board creation failed with status ${error.status}. Try again.`;
    }
    if (error instanceof Error && error.message) return error.message;
    return "Could not create the board. Try again.";
  }

  private messageFromBody(body: unknown): string | null {
    if (!body || typeof body !== "object") return null;
    const record = body as Record<string, unknown>;
    if (typeof record["message"] === "string") return record["message"];
    if (typeof record["error"] === "string") return record["error"];
    return null;
  }

  private isPlanLimitError(body: unknown): boolean {
    if (!body || typeof body !== "object") return false;
    const record = body as Record<string, unknown>;
    return record["code"] === "PLAN_LIMIT" && record["limit"] === "boards";
  }

  private markBoardLimitReached() {
    const max = this.auth.maxBoards();
    if (max !== null) this.boardCount.set(max);
  }

  private async refreshBoardHeadroom(): Promise<void> {
    const max = this.auth.maxBoards();
    if (max === null) {
      this.boardHeadroomLoaded.set(true);
      return;
    }
    try {
      const home = await this.api.get<OnboardingHomeResponse>("/home/boards");
      this.boardCount.set(home.groups.reduce((sum, group) => sum + group.boards.length, 0));
    } catch {
      // If the headroom check cannot load, leave enforcement to the API transaction.
    } finally {
      this.boardHeadroomLoaded.set(true);
    }
  }

  private templateById(templateId: WorkspaceTemplateId): WorkspaceTemplate {
    return this.templates.find((template) => template.id === templateId) ?? DEFAULT_WORKSPACE_TEMPLATE;
  }

  private nextDraftId(prefix: string): string {
    this.draftSequence += 1;
    return `${prefix}-${this.draftSequence}`;
  }
}
