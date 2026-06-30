import type { CdkDragDrop} from "@angular/cdk/drag-drop";
import type { OnDestroy} from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, ViewEncapsulation, computed, effect, inject, input, signal } from "@angular/core";
import { ActivatedRoute, NavigationEnd, Router, RouterLink } from "@angular/router";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { AUTOMATION_ACTION_LIMIT, AUTOMATION_LIMIT } from "@kanera/shared/automation-limits";
import type { ColorToken } from "@kanera/shared/colors";
import type { AutomationActionBody, AutomationTriggerTypeDto, CustomFieldTypeName, DueDateSlot } from "@kanera/shared/dto";
import { CARD_LABEL_NAME_MAX_LENGTH, WORKSPACE_ENTITY_NAME_MAX_LENGTH } from "@kanera/shared/dto/name-limits";
import type { ServerToClientEvents, WireAutomation, WireAutomationAction, WireCardLabel, WireChecklistTemplate, WireCustomField, WireCustomFieldOption } from "@kanera/shared/events";
import type { Board, BoardGroup, List, Workspace, WorkspaceMember } from "@kanera/shared/schema";
import { DEFAULT_COMPLETED_CARDS_ACTIVE_DAYS } from "@kanera/shared/workspace-defaults";
import { filter } from "rxjs";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { SocketService } from "../../core/realtime/socket.service";
import { AppTitleService } from "../../core/title/app-title.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { ConfirmService } from "../../shared/confirm.service";
import { WorkspaceSettingsApiPage } from "./api/api.page";
import { WorkspaceSettingsAutomationsPage } from "./automations/automations.page";
import { WorkspaceSettingsBoardsPage } from "./boards/boards.page";
import { WorkspaceSettingsFieldsPage } from "./fields/fields.page";
import { WorkspaceSettingsGeneralPage } from "./general/general.page";
import { WorkspaceSettingsGuestsPage } from "./guests/guests.page";
import { WorkspaceSettingsImportPage } from "./import/import.page";
import { WorkspaceSettingsLabelsPage } from "./labels/labels.page";
import { WorkspaceSettingsListsPage } from "./lists/lists.page";
import { WorkspaceSettingsMembersPage } from "./members/members.page";
import { WorkspaceSettingsTemplatesPage } from "./templates/templates.page";

type MemberRow = WorkspaceMember & { email: string; displayName: string; avatarUrl: string | null; lastOnlineAt?: string | Date | null };
type WorkspaceRole = "owner" | "admin" | "editor" | "observer";
type BoardGuestRole = "editor" | "observer";
type ApiKeyScope = "read" | "write" | "admin";
type WorkspaceSettingsTab = "general" | "boards" | "lists" | "fields" | "templates" | "automations" | "labels" | "members" | "guests" | "api" | "import";
type WorkspaceGuestBoard = Pick<Board, "id" | "name" | "icon" | "iconColor" | "position">;
type AcceptedGuestRow = {
  boardId: string;
  boardName: string;
  userId: string;
  role: BoardGuestRole;
  addedAt: string | Date;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  lastOnlineAt?: string | Date | null;
  clientId: string;
  paidGuestSeat?: boolean;
};
type PendingGuestInviteRow = {
  id: string;
  boardId: string;
  boardName: string;
  email: string;
  role: BoardGuestRole;
  expiresAt: string | Date | null;
  createdAt: string | Date;
  url?: string;
  boards?: { boardId: string; boardName: string; role: BoardGuestRole }[];
};
type WorkspaceGuestsResponse = {
  boards: WorkspaceGuestBoard[];
  acceptedGuests: AcceptedGuestRow[];
  pendingInvites: PendingGuestInviteRow[];
};
type GuestSeatPreviewResponse = {
  paidGuestSeatRequired: boolean;
  paidGuestSeatActive: boolean;
};
type RemoveGuestResponse = { paidGuestSeatRemoved?: boolean };
type WorkspaceApiKeyRow = {
  id: string;
  workspaceId: string;
  createdById: string;
  createdByName: string;
  createdByEmail: string;
  name: string;
  keyPrefix: string;
  scope: ApiKeyScope;
  lastUsedAt: string | Date | null;
  createdAt: string | Date;
};
type WebhookEndpointRow = {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  createdAt: string | Date;
  updatedAt: string | Date;
};
type WebhookDeliveryRow = {
  id: string;
  eventType: string;
  status: "queued" | "delivering" | "success" | "failed";
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: string | Date;
};
type ValidationIssue = { path?: (string | number)[]; message?: string };
type ErrorBody = { message?: string; issues?: ValidationIssue[]; code?: string };

const normalizeCustomFieldName = (name: string) => name.trim().toLocaleLowerCase();
const workspaceSettingsTabs = ["general", "boards", "lists", "fields", "templates", "automations", "labels", "members", "guests", "api", "import"] as const;
const automationActionTypes = ["add_labels", "remove_labels", "add_assignees", "remove_assignees", "apply_checklists", "set_due_date", "clear_due_date", "set_completion", "move_to_list", "move_to_top", "move_to_bottom", "populate_custom_field"] as const;
type AutomationActionTypeName = (typeof automationActionTypes)[number];
type AutomationTriggerTypeName = AutomationTriggerTypeDto;
type PopulateCustomFieldAction = Extract<AutomationActionBody, { type: "populate_custom_field" }>;
type PopulateCustomFieldValue = PopulateCustomFieldAction["config"]["value"];
type PopulateTextDateFormat = Extract<PopulateCustomFieldValue, { kind: "text_current_date" }>["format"];
type PopulateTextSource = "text" | "current_date";
type PopulateDateSource = "fixed" | "current";
type AutomationDueDatePreset = "0" | "1" | "2" | "7" | "custom";
const automationTextDateFormats = ["date", "month", "datetime"] as const satisfies readonly PopulateTextDateFormat[];
const automationSetCustomFieldTypes = ["text", "number", "date", "checkbox", "select", "user"] as const satisfies readonly CustomFieldTypeName[];
const automationDueDatePresets = [
  { value: "0", label: "Today" },
  { value: "1", label: "Tomorrow" },
  { value: "2", label: "In 2 days" },
  { value: "7", label: "In 1 week" },
  { value: "custom", label: "Custom..." },
] as const satisfies readonly { value: AutomationDueDatePreset; label: string }[];
const automationDueDatePresetOffsets = new Set<number>(automationDueDatePresets.filter((option) => option.value !== "custom").map((option) => Number(option.value)));

function isWorkspaceSettingsTab(tab: string | undefined): tab is WorkspaceSettingsTab {
  return !!tab && (workspaceSettingsTabs as readonly string[]).includes(tab);
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as ErrorBody | undefined;
    const issueMessages = body?.issues
      ?.map((issue) => {
        const field = issue.path?.join(".");
        if (field === "url" && issue.message?.toLowerCase().includes("url")) {
          return "Please enter a valid webhook URL.";
        }
        if (issue.message) return issue.message;
        return field ? `Please check ${field}.` : null;
      })
      .filter(Boolean);
    if (issueMessages?.length) return issueMessages.join("; ");
    return body?.message ?? "Something went wrong. Please try again.";
  }
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

// Adding this guest would cross the host org's free guest-board cap but its purchased seat pool is full
// (block-until-buy). The admin must buy more seats on the plan page before assigning this person.
function isSeatLimitReached(error: unknown): boolean {
  return error instanceof ApiError && (error.body as ErrorBody | undefined)?.code === "SEAT_LIMIT_REACHED";
}

function sortBoards<T extends { position: string }>(boards: T[]): T[] {
  return [...boards].sort((a, b) => Number(a.position) - Number(b.position));
}

function toGuestBoard(board: Board): WorkspaceGuestBoard {
  return {
    id: board.id,
    name: board.name,
    icon: board.icon,
    iconColor: board.iconColor,
    position: board.position,
  };
}

function sortBoardGroups<T extends { position: string }>(groups: T[]): T[] {
  return [...groups].sort((a, b) => Number(a.position) - Number(b.position));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

@Component({
  selector: "k-workspace-settings",
  standalone: true,
  imports: [RouterLink, WorkspaceSettingsGeneralPage, WorkspaceSettingsBoardsPage, WorkspaceSettingsListsPage, WorkspaceSettingsFieldsPage, WorkspaceSettingsTemplatesPage, WorkspaceSettingsAutomationsPage, WorkspaceSettingsLabelsPage, WorkspaceSettingsMembersPage, WorkspaceSettingsGuestsPage, WorkspaceSettingsApiPage, WorkspaceSettingsImportPage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  templateUrl: "./workspace-settings.page.html",
  styleUrl: "./workspace-settings.page.scss",
})
export class WorkspaceSettingsPage implements OnDestroy {
  readonly completedCardsActiveDaysDefault = DEFAULT_COMPLETED_CARDS_ACTIVE_DAYS;

  private readonly api = inject(ApiClient);
  private readonly appTitle = inject(AppTitleService);
  private readonly auth = inject(AuthService);
  private readonly confirm = inject(ConfirmService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sockets = inject(SocketService);
  private readonly workspaceService = inject(WorkspaceService);
  private nameSaveTimer: ReturnType<typeof setTimeout> | null = null;

  readonly workspaceId = input.required<string>();
  private readonly routeTab = signal<string | undefined>(undefined);
  readonly selectedTab = signal<WorkspaceSettingsTab>("general");
  readonly workspace = signal<Workspace | null>(null);
  readonly lists = signal<List[]>([]);
  readonly fields = signal<WireCustomField[]>([]);
  readonly templates = signal<WireChecklistTemplate[]>([]);
  readonly automations = signal<WireAutomation[]>([]);
  readonly labels = signal<WireCardLabel[]>([]);
  readonly members = signal<MemberRow[]>([]);
  readonly name = signal("");
  readonly icon = signal("rocket");
  readonly accentColor = signal<ColorToken | null>(null);
  readonly newList = signal("");
  readonly newListIcon = signal<string | null>(null);
  readonly newListColor = signal<ColorToken | null>(null);
  readonly newField = signal("");
  readonly newFieldIcon = signal("forms");
  readonly newFieldType = signal<CustomFieldTypeName>("text");
  readonly newFieldAllowMultiple = signal(false);
  // Draft label for adding an option to a select field, keyed by field id.
  readonly newOptionLabel = signal<Record<string, string>>({});
  // Draft color for adding an option to a select field, keyed by field id.
  readonly newOptionColor = signal<Record<string, ColorToken | null>>({});
  readonly newLabel = signal("");
  readonly newLabelColor = signal<ColorToken | null>(null);
  readonly boardList = signal<Board[]>([]);
  readonly boardGroups = signal<BoardGroup[]>([]);
  readonly newBoardGroupTitle = signal("");
  readonly editingBoardGroupId = signal<string | null>(null);
  readonly editingBoardGroupTitle = signal("");
  readonly newBoardName = signal("");
  readonly editingBoardId = signal<string | null>(null);
  readonly editingBoardName = signal("");
  readonly editingListId = signal<string | null>(null);
  readonly editingListName = signal("");
  readonly editingFieldId = signal<string | null>(null);
  readonly editingFieldName = signal("");
  readonly newTemplate = signal("");
  readonly editingTemplateId = signal<string | null>(null);
  readonly editingTemplateName = signal("");
  readonly expandedTemplateIds = signal<ReadonlySet<string>>(new Set());
  readonly newTemplateItem = signal<Record<string, string>>({});
  readonly expandedAutomationIds = signal<ReadonlySet<string>>(new Set());
  readonly automationActionDrafts = signal<Record<string, AutomationActionBody[]>>({});
  readonly customAutomationDueDateDrafts = signal<ReadonlySet<string>>(new Set());
  readonly automationActionTypes = automationActionTypes;
  readonly automationActionLimit = AUTOMATION_ACTION_LIMIT;
  readonly automationLimit = AUTOMATION_LIMIT;
  readonly automationLimitHint = `Workspaces can have up to ${AUTOMATION_LIMIT} automations. Contact support if you need more.`;
  readonly automationLimitReached = computed(() => this.automations().length >= AUTOMATION_LIMIT);
  readonly automationTextDateFormats = automationTextDateFormats;
  readonly automationDueDatePresets = automationDueDatePresets;
  readonly automationSetCustomFields = computed(() => this.fields().filter((field) => (automationSetCustomFieldTypes as readonly CustomFieldTypeName[]).includes(field.type)));
  readonly automationMembers = computed(() =>
    [...this.members()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }) ||
      a.email.localeCompare(b.email, undefined, { sensitivity: "base" }),
    ),
  );
  readonly dueDateSlots: DueDateSlot[] = ["anyTime", "morning", "afternoon", "endOfWorkDay"];
  readonly editingLabelId = signal<string | null>(null);
  readonly editingLabelName = signal("");
  readonly addMemberUserId = signal("");
  readonly addMemberRole = signal<WorkspaceRole>("editor");
  readonly memberSearch = signal("");
  readonly guestBoards = signal<WorkspaceGuestBoard[]>([]);
  readonly acceptedGuests = signal<AcceptedGuestRow[]>([]);
  readonly pendingGuestInvites = signal<PendingGuestInviteRow[]>([]);
  readonly guestBoardId = signal("");
  readonly guestEmail = signal("");
  readonly guestRole = signal<BoardGuestRole>("editor");
  readonly guestError = signal<string | null>(null);
  readonly guestBusy = signal(false);
  readonly guestRemovingId = signal<string | null>(null);
  readonly createdGuestInviteUrl = signal<string | null>(null);
  readonly guestInviteCopied = signal(false);
  readonly duplicatePendingGuestInvite = computed(() => {
    const boardId = this.guestBoardId();
    const email = this.guestEmail().trim().toLowerCase();
    if (!boardId || !email) return false;
    return this.pendingGuestInvites().some((invite) => {
      if (invite.email.toLowerCase() !== email) return false;
      const boards = invite.boards ?? [{ boardId: invite.boardId, boardName: invite.boardName, role: invite.role }];
      return boards.some((board) => board.boardId === boardId);
    });
  });
  readonly orgUsers = signal<{ id: string; email: string; displayName: string }[]>([]);
  readonly availableOrgUsers = computed(() => {
    const memberIds = new Set(this.members().map((m) => m.userId));
    return this.orgUsers().filter((u) => !memberIds.has(u.id));
  });
  readonly filteredMembers = computed(() => {
    const q = this.memberSearch().trim().toLowerCase();
    if (!q) return this.members();
    return this.members().filter(
      (m) => m.displayName.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
    );
  });
  readonly currentUserId = computed(() => this.auth.user()?.id ?? "");
  readonly currentMember = computed(() => this.members().find((m) => m.userId === this.currentUserId()) ?? null);
  readonly workspaceRole = computed(() => (this.workspace() as (Workspace & { role?: WorkspaceRole }) | null)?.role ?? null);
  readonly canControlOwners = computed(() => this.currentMember()?.role === "owner");
  readonly canManageApi = computed(() => {
    const role = this.currentMember()?.role ?? this.workspaceRole();
    return role === "owner" || role === "admin" || this.auth.isOrgAdmin();
  });
  readonly canManageGuests = this.canManageApi;

  // Plan-tier gating. The API enforces every limit; these only drive UI affordances (disabled
  // buttons + upgrade hints). A null max means unlimited (trial/paid/self-hosted).
  readonly guestsAllowed = this.auth.guestsAllowed;
  readonly apiAllowed = this.auth.apiAllowed;
  readonly webhooksAllowed = this.auth.webhooksAllowed;
  readonly boardLimitReached = computed(() => {
    const max = this.auth.maxBoards();
    return max !== null && this.boardList().length >= max;
  });
  readonly enabledAutomationLimitReached = computed(() => {
    const max = this.auth.maxEnabledAutomations();
    return max !== null && this.automations().filter((a) => a.enabled).length >= max;
  });
  readonly enabledAutomationLimitHint = computed(() => {
    const max = this.auth.maxEnabledAutomations();
    return max === null ? null : `Your plan allows ${max} enabled automation${max === 1 ? "" : "s"} at a time.`;
  });
  readonly planUpgradeHint = "Upgrade your plan to unlock this.";
  readonly workspaceEntityNameMaxLength = WORKSPACE_ENTITY_NAME_MAX_LENGTH;
  readonly labelNameMaxLength = CARD_LABEL_NAME_MAX_LENGTH;

  readonly apiDocsUrl = "https://www.kanera.app/docs/api";
  readonly customFieldError = signal<string | null>(null);
  readonly apiKeys = signal<WorkspaceApiKeyRow[]>([]);
  readonly webhooks = signal<WebhookEndpointRow[]>([]);
  readonly webhookDeliveries = signal<Record<string, WebhookDeliveryRow[]>>({});
  readonly newApiKeyName = signal("");
  readonly newApiKeyScope = signal<ApiKeyScope>("write");
  readonly apiKeyError = signal<string | null>(null);
  readonly revealedApiKeySecret = signal<string | null>(null);
  readonly newWebhookName = signal("");
  readonly newWebhookUrl = signal("");
  readonly newWebhookEventTypes = signal("");
  readonly webhookError = signal<string | null>(null);
  readonly revealedWebhookSecret = signal<string | null>(null);
  readonly customFieldValidation = computed(() => {
    const name = this.newField().trim();
    if (!name) return this.customFieldError();
    if (this.hasDuplicateFieldName(name)) return "Custom field names must be unique within a workspace.";
    return this.customFieldError();
  });

  constructor() {
    this.updateRouteTab();
    this.router.events
      ?.pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.updateRouteTab());

    effect(() => {
      const tab = this.routeTab();
      if (!isWorkspaceSettingsTab(tab)) {
        this.selectedTab.set("general");
        return;
      }

      if ((tab === "api" && this.workspace() && !this.canManageApi()) || (tab === "guests" && this.workspace() && !this.canManageGuests())) {
        this.selectedTab.set("general");
        void this.router.navigate(["general"], {
          relativeTo: this.route,
          replaceUrl: true,
        });
        return;
      }

      this.selectedTab.set(tab);
    });

    effect(() => {
      this.appTitle.set(this.workspace()?.name ?? "Workspace", "Settings");
    });

    effect(() => {
      const color = this.accentColor();
      const style = this.el.nativeElement.style;
      if (color) {
        style.setProperty("--accent", `var(--color-${color})`);
        style.setProperty("--accent-hover", `color-mix(in srgb, var(--color-${color}), black 15%)`);
        style.setProperty("--ring", `color-mix(in srgb, var(--color-${color}) 40%, transparent)`);
      } else {
        style.removeProperty("--accent");
        style.removeProperty("--accent-hover");
        style.removeProperty("--ring");
      }
      this.workspaceService.setActiveAccentColor(color);
    });

    effect(() => {
      const selectedUserId = this.addMemberUserId();
      const availableUsers = this.availableOrgUsers();
      if (availableUsers.length === 0) {
        this.addMemberUserId.set("");
        return;
      }
      if (!selectedUserId || !availableUsers.some((user) => user.id === selectedUserId)) {
        this.addMemberUserId.set(availableUsers[0]!.id);
      }
    });

    effect(() => {
      if (!this.canControlOwners() && this.addMemberRole() === "owner") {
        this.addMemberRole.set("editor");
      }
    });

    effect(() => {
      const boards = this.guestBoards();
      const selected = this.guestBoardId();
      if (boards.length === 0) {
        this.guestBoardId.set("");
        return;
      }
      if (!selected || !boards.some((board) => board.id === selected)) {
        this.guestBoardId.set(boards[0]!.id);
      }
    });

    effect(() => {
      if (this.selectedTab() === "api" && this.workspace() && !this.canManageApi()) {
        this.selectTab("general", true);
      }
      if (this.selectedTab() === "guests" && this.workspace() && !this.canManageGuests()) {
        this.selectTab("general", true);
      }
    });

    effect((onCleanup) => {
      const workspaceId = this.workspaceId();
      let cancelled = false;
      this.reset();

      void this.reload(workspaceId).then(() => {
        if (cancelled) return;
      });
      const detach = this.attachSocket(workspaceId);

      onCleanup(() => {
        cancelled = true;
        detach();
      });
    });
  }

  private updateRouteTab() {
    this.routeTab.set(this.route.firstChild?.snapshot?.url?.[0]?.path);
  }

  ngOnDestroy() {
    this.workspaceService.setActiveAccentColor(null);
  }

  selectTab(tab: WorkspaceSettingsTab, replaceUrl = false) {
    if ((tab === "api" && !this.canManageApi()) || (tab === "guests" && !this.canManageGuests())) {
      tab = "general";
    }
    this.selectedTab.set(tab);
    void this.router.navigate([tab], {
      relativeTo: this.route,
      replaceUrl,
    });
  }

  private reset() {
    this.clearNameSaveTimer();
    this.workspace.set(null);
    this.lists.set([]);
    this.fields.set([]);
    this.templates.set([]);
    this.automations.set([]);
    this.newTemplate.set("");
    this.editingTemplateId.set(null);
    this.expandedTemplateIds.set(new Set());
    this.newTemplateItem.set({});
    this.expandedAutomationIds.set(new Set());
    this.automationActionDrafts.set({});
    this.labels.set([]);
    this.members.set([]);
    this.addMemberUserId.set("");
    this.addMemberRole.set("editor");
    this.memberSearch.set("");
    this.guestBoards.set([]);
    this.acceptedGuests.set([]);
    this.pendingGuestInvites.set([]);
    this.guestBoardId.set("");
    this.guestEmail.set("");
    this.guestRole.set("editor");
    this.guestError.set(null);
    this.guestBusy.set(false);
    this.guestRemovingId.set(null);
    this.createdGuestInviteUrl.set(null);
    this.guestInviteCopied.set(false);
    this.editingFieldId.set(null);
    this.customFieldError.set(null);
    this.boardList.set([]);
    this.boardGroups.set([]);
    this.newBoardGroupTitle.set("");
    this.editingBoardGroupId.set(null);
    this.newBoardName.set("");
    this.editingBoardId.set(null);
    this.apiKeys.set([]);
    this.webhooks.set([]);
    this.webhookDeliveries.set({});
    this.newApiKeyName.set("");
    this.newApiKeyScope.set("write");
    this.apiKeyError.set(null);
    this.revealedApiKeySecret.set(null);
    this.newWebhookName.set("");
    this.newWebhookUrl.set("");
    this.newWebhookEventTypes.set("");
    this.webhookError.set(null);
    this.revealedWebhookSecret.set(null);
  }

  async reload(workspaceId = this.workspaceId()) {
    const workspaces = await this.api.get<(Workspace & { role: string })[]>("/workspaces");
    const ws = workspaces.find((w) => w.id === workspaceId) ?? null;
    const canManageApi = ws?.role === "owner" || ws?.role === "admin" || this.auth.isOrgAdmin();
    const [detail, members, orgUsers, boards, boardGroups] = await Promise.all([
      this.api.get<{ lists: List[]; customFields: WireCustomField[]; cardLabels: WireCardLabel[]; checklistTemplates: WireChecklistTemplate[]; automations: WireAutomation[] }>(`/workspaces/${workspaceId}`),
      this.api.get<MemberRow[]>(`/workspaces/${workspaceId}/members`),
      this.api.get<{ id: string; email: string; displayName: string }[]>(`/workspaces/${workspaceId}/member-candidates`),
      this.api.get<Board[]>(`/workspaces/${workspaceId}/boards`),
      this.api.get<BoardGroup[]>(`/workspaces/${workspaceId}/board-groups`),
    ]);
    const [apiKeys, webhooks, guests] = canManageApi
      ? await Promise.all([
        this.api.get<WorkspaceApiKeyRow[]>(`/workspaces/${workspaceId}/api-keys`),
        this.api.get<WebhookEndpointRow[]>(`/workspaces/${workspaceId}/webhooks`),
        this.api.get<WorkspaceGuestsResponse>(`/workspaces/${workspaceId}/guests`),
      ])
      : [[] as WorkspaceApiKeyRow[], [] as WebhookEndpointRow[], null];
    if (workspaceId !== this.workspaceId()) return;
    this.applyWorkspace(ws, true);
    this.lists.set([...detail.lists].sort((a, b) => Number(a.position) - Number(b.position)));
    this.fields.set([...detail.customFields].sort((a, b) => Number(a.position) - Number(b.position)));
    this.templates.set(this.sortTemplates(detail.checklistTemplates ?? []));
    this.automations.set(this.sortAutomations((detail.automations ?? []).map((automation) => this.normalizeAutomation(automation))));
    this.labels.set([...detail.cardLabels].sort((a, b) => Number(a.position) - Number(b.position)));
    this.members.set(members);
    this.orgUsers.set(orgUsers);
    this.boardList.set(sortBoards(boards));
    this.boardGroups.set(sortBoardGroups(boardGroups));
    this.guestBoards.set(sortBoards(guests?.boards ?? boards));
    this.acceptedGuests.set(guests?.acceptedGuests ?? []);
    this.pendingGuestInvites.set(guests?.pendingInvites ?? []);
    this.apiKeys.set(apiKeys);
    this.webhooks.set(webhooks);
  }

  private attachSocket(activeWorkspaceId: string) {
    const socket = this.sockets.connect();
    const leaveWorkspace = this.sockets.joinWorkspace(activeWorkspaceId);
    const matchWs = (workspaceId: string) => workspaceId === activeWorkspaceId;

    const handlers: Partial<ServerToClientEvents> = {
      "list:created": ({ workspaceId, list }) => {
        if (!matchWs(workspaceId)) return;
        this.lists.update((ls) => [...ls.filter((l) => l.id !== list.id), list as unknown as List]);
      },
      "list:updated": ({ workspaceId, list }) => {
        if (!matchWs(workspaceId)) return;
        this.lists.update((ls) => ls.map((l) => (l.id === list.id ? (list as unknown as List) : l)));
      },
      "list:moved": ({ workspaceId, listId, position }) => {
        if (!matchWs(workspaceId)) return;
        this.lists.update((ls) =>
          ls
            .map((l) => (l.id === listId ? { ...l, position } : l))
            .sort((a, b) => Number(a.position) - Number(b.position)),
        );
      },
      "list:rebalanced": ({ workspaceId, positions }) => {
        if (!matchWs(workspaceId)) return;
        this.lists.update((ls) =>
          ls
            .map((l) => {
              const next = positions.find((p) => p.id === l.id);
              return next ? { ...l, position: next.position } : l;
            })
            .sort((a, b) => Number(a.position) - Number(b.position)),
        );
      },
      "list:deleted": ({ workspaceId, listId }) => {
        if (!matchWs(workspaceId)) return;
        this.lists.update((ls) => ls.filter((l) => l.id !== listId));
      },
      "customField:created": ({ workspaceId, customField }) => {
        if (!matchWs(workspaceId)) return;
        this.fields.update((fs) => [...fs.filter((f) => f.id !== customField.id), customField]);
      },
      "customField:updated": ({ workspaceId, customField }) => {
        if (!matchWs(workspaceId)) return;
        this.fields.update((fs) => fs.map((f) => (f.id === customField.id ? customField : f)));
      },
      "customField:moved": ({ workspaceId, fieldId, position }) => {
        if (!matchWs(workspaceId)) return;
        this.fields.update((fs) =>
          fs
            .map((f) => (f.id === fieldId ? { ...f, position } : f))
            .sort((a, b) => Number(a.position) - Number(b.position)),
        );
      },
      "customField:rebalanced": ({ workspaceId, positions }) => {
        if (!matchWs(workspaceId)) return;
        this.fields.update((fs) =>
          fs
            .map((f) => {
              const next = positions.find((p) => p.id === f.id);
              return next ? { ...f, position: next.position } : f;
            })
            .sort((a, b) => Number(a.position) - Number(b.position)),
        );
      },
      "customField:deleted": ({ workspaceId, fieldId }) => {
        if (!matchWs(workspaceId)) return;
        this.fields.update((fs) => fs.filter((f) => f.id !== fieldId));
      },
      "customFieldOption:created": ({ workspaceId, fieldId, option }) => {
        if (!matchWs(workspaceId)) return;
        this.applyOptionChange(fieldId, (options) => [...options.filter((o) => o.id !== option.id), option]);
      },
      "customFieldOption:updated": ({ workspaceId, fieldId, option }) => {
        if (!matchWs(workspaceId)) return;
        this.applyOptionChange(fieldId, (options) => options.map((o) => (o.id === option.id ? option : o)));
      },
      "customFieldOption:moved": ({ workspaceId, fieldId, optionId, position }) => {
        if (!matchWs(workspaceId)) return;
        this.applyOptionChange(fieldId, (options) => options.map((o) => (o.id === optionId ? { ...o, position } : o)));
      },
      "customFieldOption:rebalanced": ({ workspaceId, fieldId, positions }) => {
        if (!matchWs(workspaceId)) return;
        const positionsById = new Map(positions.map((p) => [p.id, p.position]));
        this.applyOptionChange(fieldId, (options) =>
          options.map((o) => {
            const next = positionsById.get(o.id);
            return next ? { ...o, position: next } : o;
          }),
        );
      },
      "customFieldOption:deleted": ({ workspaceId, fieldId, optionId }) => {
        if (!matchWs(workspaceId)) return;
        this.applyOptionChange(fieldId, (options) => options.filter((o) => o.id !== optionId));
      },
      "checklistTemplate:created": ({ workspaceId, template }) => {
        if (!matchWs(workspaceId)) return;
        this.templates.update((ts) => this.sortTemplates([...ts.filter((t) => t.id !== template.id), template]));
      },
      "checklistTemplate:updated": ({ workspaceId, template }) => {
        if (!matchWs(workspaceId)) return;
        this.templates.update((ts) => ts.map((t) => (t.id === template.id ? template : t)));
      },
      "checklistTemplate:moved": ({ workspaceId, templateId, position }) => {
        if (!matchWs(workspaceId)) return;
        this.templates.update((ts) =>
          this.sortTemplates(ts.map((t) => (t.id === templateId ? { ...t, position } : t))),
        );
      },
      "checklistTemplate:rebalanced": ({ workspaceId, positions }) => {
        if (!matchWs(workspaceId)) return;
        this.templates.update((ts) =>
          this.sortTemplates(ts.map((t) => {
            const next = positions.find((p) => p.id === t.id);
            return next ? { ...t, position: next.position } : t;
          })),
        );
      },
      "checklistTemplate:deleted": ({ workspaceId, templateId }) => {
        if (!matchWs(workspaceId)) return;
        this.templates.update((ts) => ts.filter((t) => t.id !== templateId));
      },
      "automation:created": ({ workspaceId, automation }) => {
        if (!matchWs(workspaceId)) return;
        const normalized = this.normalizeAutomation(automation);
        this.automations.update((items) => this.sortAutomations([...items.filter((item) => item.id !== normalized.id), normalized]));
      },
      "automation:updated": ({ workspaceId, automation }) => {
        if (!matchWs(workspaceId)) return;
        this.replaceAutomation(automation);
      },
      "automation:moved": ({ workspaceId, automationId, position }) => {
        if (!matchWs(workspaceId)) return;
        this.automations.update((items) => this.sortAutomations(items.map((item) => (item.id === automationId ? { ...item, position } : item))));
      },
      "automation:rebalanced": ({ workspaceId, positions }) => {
        if (!matchWs(workspaceId)) return;
        this.automations.update((items) => this.sortAutomations(items.map((item) => {
          const next = positions.find((position) => position.id === item.id);
          return next ? { ...item, position: next.position } : item;
        })));
      },
      "automation:deleted": ({ workspaceId, automationId }) => {
        if (!matchWs(workspaceId)) return;
        this.automations.update((items) => items.filter((item) => item.id !== automationId));
      },
      "cardLabel:created": ({ workspaceId, cardLabel }) => {
        if (!matchWs(workspaceId)) return;
        this.labels.update((ls) => [...ls.filter((l) => l.id !== cardLabel.id), cardLabel]);
      },
      "cardLabel:updated": ({ workspaceId, cardLabel }) => {
        if (!matchWs(workspaceId)) return;
        this.labels.update((ls) => ls.map((l) => (l.id === cardLabel.id ? cardLabel : l)));
      },
      "cardLabel:moved": ({ workspaceId, labelId, position }) => {
        if (!matchWs(workspaceId)) return;
        this.labels.update((ls) =>
          ls
            .map((l) => (l.id === labelId ? { ...l, position } : l))
            .sort((a, b) => Number(a.position) - Number(b.position)),
        );
      },
      "cardLabel:rebalanced": ({ workspaceId, positions }) => {
        if (!matchWs(workspaceId)) return;
        this.labels.update((ls) =>
          ls
            .map((l) => {
              const next = positions.find((p) => p.id === l.id);
              return next ? { ...l, position: next.position } : l;
            })
            .sort((a, b) => Number(a.position) - Number(b.position)),
        );
      },
      "cardLabel:deleted": ({ workspaceId, labelId }) => {
        if (!matchWs(workspaceId)) return;
        this.labels.update((ls) => ls.filter((l) => l.id !== labelId));
      },
      "workspace:updated": ({ workspace }) => {
        if (!matchWs(workspace.id)) return;
        this.applyWorkspace(workspace as unknown as Workspace, this.name() === this.workspace()?.name);
      },
      "workspace:deleted": ({ workspaceId }) => {
        if (!matchWs(workspaceId)) return;
        this.workspaceService.removeWorkspace(workspaceId);
        void this.router.navigateByUrl("/");
      },
      "workspace:member:added": ({ workspaceId, member }) => {
        if (!matchWs(workspaceId)) return;
        this.members.update((rows) => rows.some((r) => r.userId === member.userId) ? rows : [...rows, member as unknown as MemberRow]);
      },
      "workspace:member:updated": ({ workspaceId, member }) => {
        if (!matchWs(workspaceId)) return;
        this.members.update((rows) => rows.map((r) => (r.userId === member.userId ? { ...r, role: member.role } : r)));
      },
      "user:profile:updated": ({ userId, displayName, avatarUrl }) => {
        this.members.update((rows) => rows.map((row) => row.userId === userId ? { ...row, displayName, avatarUrl } : row));
        this.acceptedGuests.update((rows) => rows.map((row) => row.userId === userId ? { ...row, displayName, avatarUrl } : row));
      },
      "workspace:member:removed": ({ workspaceId, userId }) => {
        if (!matchWs(workspaceId)) return;
        this.members.update((rows) => rows.filter((r) => r.userId !== userId));
      },
      "board:created": ({ workspaceId, board }) => {
        if (!matchWs(workspaceId)) return;
        this.boardList.update((bs) => bs.some((b) => b.id === board.id) ? bs : sortBoards([...bs, board as unknown as Board]));
        this.upsertGuestBoard(board as unknown as Board);
      },
      "board:updated": ({ board }) => {
        const updated = board as unknown as Board;
        this.boardList.update((bs) => sortBoards(bs.map((b) => (b.id === updated.id ? updated : b))));
        this.updateGuestBoard(updated);
      },
      "board:moved": ({ workspaceId, boardId, position }) => {
        if (!matchWs(workspaceId)) return;
        this.boardList.update((bs) => sortBoards(bs.map((b) => (b.id === boardId ? { ...b, position } : b))));
        this.guestBoards.update((boards) => sortBoards(boards.map((board) => board.id === boardId ? { ...board, position } : board)));
      },
      "board:rebalanced": ({ workspaceId, positions }) => {
        if (!matchWs(workspaceId)) return;
        const positionsById = new Map(positions.map((p) => [p.id, p.position]));
        this.boardList.update((bs) => sortBoards(bs.map((b) => {
          const pos = positionsById.get(b.id);
          return pos ? { ...b, position: pos } : b;
        })));
        this.guestBoards.update((boards) => sortBoards(boards.map((board) => {
          const position = positionsById.get(board.id);
          return position ? { ...board, position } : board;
        })));
      },
      "board:deleted": ({ boardId }) => {
        this.boardList.update((bs) => bs.filter((b) => b.id !== boardId));
        this.removeGuestBoard(boardId);
      },
      "boardGroup:created": ({ workspaceId, group }) => {
        if (!matchWs(workspaceId)) return;
        this.boardGroups.update((groups) => sortBoardGroups([...groups.filter((g) => g.id !== group.id), group as unknown as BoardGroup]));
      },
      "boardGroup:updated": ({ workspaceId, group }) => {
        if (!matchWs(workspaceId)) return;
        this.boardGroups.update((groups) => sortBoardGroups(groups.map((g) => g.id === group.id ? group as unknown as BoardGroup : g)));
      },
      "boardGroup:moved": ({ workspaceId, groupId, position }) => {
        if (!matchWs(workspaceId)) return;
        this.boardGroups.update((groups) => sortBoardGroups(groups.map((g) => g.id === groupId ? { ...g, position } : g)));
      },
      "boardGroup:rebalanced": ({ workspaceId, positions }) => {
        if (!matchWs(workspaceId)) return;
        const positionsById = new Map(positions.map((p) => [p.id, p.position]));
        this.boardGroups.update((groups) => sortBoardGroups(groups.map((g) => {
          const position = positionsById.get(g.id);
          return position ? { ...g, position } : g;
        })));
      },
      "boardGroup:deleted": ({ workspaceId, groupId }) => {
        if (!matchWs(workspaceId)) return;
        this.boardGroups.update((groups) => groups.filter((g) => g.id !== groupId));
        this.boardList.update((boards) => boards.map((board) => board.groupId === groupId ? { ...board, groupId: null } : board));
      },
    };

    for (const [event, handler] of Object.entries(handlers)) {
      socket.on(event as keyof ServerToClientEvents, handler as never);
    }
    return () => {
      for (const [event, handler] of Object.entries(handlers)) {
        socket.off(event as keyof ServerToClientEvents, handler as never);
      }
      leaveWorkspace();
    };
  }

  private applyWorkspace(ws: Workspace | null, syncControls = false) {
    this.workspace.set(ws);
    const accentColor = (ws as { accentColor?: string | null } | null)?.accentColor as ColorToken | null ?? null;
    if (syncControls) {
      this.name.set(ws?.name ?? "");
      this.icon.set(ws?.icon ?? "rocket");
      this.accentColor.set(accentColor);
    }
    if (ws) this.workspaceService.updateAccentColor(ws.id, accentColor);
  }

  private upsertGuestBoard(board: Board) {
    // Guests invite against the same workspace boards shown on the Boards tab, so board mutations
    // must keep this selector warm instead of waiting for a full settings reload.
    const guestBoard = toGuestBoard(board);
    this.guestBoards.update((boards) => sortBoards([...boards.filter((item) => item.id !== guestBoard.id), guestBoard]));
  }

  private updateGuestBoard(board: Board) {
    this.guestBoards.update((boards) => sortBoards(boards.map((item) => item.id === board.id ? { ...item, ...toGuestBoard(board) } : item)));
  }

  private removeGuestBoard(boardId: string) {
    this.guestBoards.update((boards) => boards.filter((board) => board.id !== boardId));
  }

  private clearNameSaveTimer() {
    if (!this.nameSaveTimer) return;
    clearTimeout(this.nameSaveTimer);
    this.nameSaveTimer = null;
  }

  private async patchWorkspace(patch: { name?: string; icon?: string | null; accentColor?: ColorToken | null; completedCardsActiveDays?: number }) {
    const ws = await this.api.patch<Workspace>(`/workspaces/${this.workspaceId()}`, patch);
    this.applyWorkspace(ws);
  }

  updateWorkspaceName(value: string) {
    this.name.set(value);
    this.clearNameSaveTimer();
    const name = value.trim();
    if (!name || name === this.workspace()?.name) return;
    this.nameSaveTimer = setTimeout(() => {
      this.nameSaveTimer = null;
      void this.patchWorkspace({ name });
    }, 300);
  }

  saveWorkspaceNameNow() {
    this.clearNameSaveTimer();
    const name = this.name().trim();
    if (!name || name === this.workspace()?.name) return;
    void this.patchWorkspace({ name });
  }

  updateWorkspaceIcon(icon: string) {
    this.icon.set(icon);
    void this.patchWorkspace({ icon });
  }

  updateWorkspaceAccentColor(accentColor: ColorToken | null) {
    this.accentColor.set(accentColor);
    this.workspaceService.updateAccentColor(this.workspaceId(), accentColor);
    void this.patchWorkspace({ accentColor });
  }

  updateCompletedCardsActiveDays(value: string) {
    const days = Math.max(0, Math.min(365, Math.trunc(Number(value) || 0)));
    void this.patchWorkspace({ completedCardsActiveDays: days });
  }

  async addList(e: Event) {
    e.preventDefault();
    const name = this.newList().trim();
    if (!name) return;
    await this.api.post<List>(`/workspaces/${this.workspaceId()}/lists`, {
      name,
      icon: this.newListIcon() ?? "list",
      color: this.newListColor() ?? undefined,
    });
    this.newList.set("");
    this.newListIcon.set(null);
    this.newListColor.set(null);
  }

  async updateListStyle(id: string, patch: { icon?: string | null; color?: string | null }) {
    const list = await this.api.patch<List>(`/lists/${id}`, patch);
    this.lists.update((items) => items.map((l) => (l.id === id ? list : l)));
  }

  async archiveList(id: string) {
    const list = this.lists().find((l) => l.id === id);
    if (!list) return;
    if (!await this.confirm.open({ title: `Delete list "${list.name}"?`, message: "This cannot be undone." })) return;
    await this.api.delete(`/lists/${id}`);
    this.lists.update((items) => items.filter((l) => l.id !== id));
  }

  startEditList(list: List) {
    this.editingListId.set(list.id);
    this.editingListName.set(list.name);
  }

  cancelEditList() {
    this.editingListId.set(null);
  }

  async saveListName(id: string) {
    const name = this.editingListName().trim();
    this.editingListId.set(null);
    if (!name) return;
    const current = this.lists().find((l) => l.id === id);
    if (!current || name === current.name) return;
    const list = await this.api.patch<List>(`/lists/${id}`, { name });
    this.lists.update((items) => items.map((l) => (l.id === id ? list : l)));
  }

  async dropList(event: CdkDragDrop<List[]>) {
    if (event.previousIndex === event.currentIndex) return;
    const items = this.lists();
    const moved = items[event.previousIndex];
    if (!moved) return;
    const reordered = [...items];
    reordered.splice(event.previousIndex, 1);
    reordered.splice(event.currentIndex, 0, moved);
    this.lists.set(reordered);

    const body =
      event.currentIndex === 0
        ? { beforeListId: reordered[1]?.id ?? null }
        : { afterListId: reordered[event.currentIndex - 1]?.id };
    await this.api.post(`/lists/${moved.id}/move`, body);
  }

  async addField(e: Event) {
    e.preventDefault();
    const name = this.newField().trim();
    if (!name) return;
    this.customFieldError.set(null);
    if (this.hasDuplicateFieldName(name)) return;
    const type = this.newFieldType();
    const supportsMultiple = type === "select" || type === "user";
    try {
      await this.api.post<WireCustomField>(`/workspaces/${this.workspaceId()}/custom-fields`, {
        name,
        icon: this.newFieldIcon(),
        type,
        allowMultiple: supportsMultiple ? this.newFieldAllowMultiple() : false,
      });
      this.newField.set("");
      this.newFieldIcon.set("forms");
      this.newFieldType.set("text");
      this.newFieldAllowMultiple.set(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        this.customFieldError.set("Custom field names must be unique within a workspace.");
        return;
      }
      throw error;
    }
  }

  startEditField(field: WireCustomField) {
    this.editingFieldId.set(field.id);
    this.editingFieldName.set(field.name);
  }

  cancelEditField() {
    this.editingFieldId.set(null);
  }

  async saveFieldName(id: string) {
    const name = this.editingFieldName().trim();
    this.editingFieldId.set(null);
    if (!name) return;
    const current = this.fields().find((f) => f.id === id);
    if (!current || name === current.name) return;
    try {
      const field = await this.api.patch<WireCustomField>(`/custom-fields/${id}`, { name });
      this.fields.update((items) => items.map((f) => (f.id === id ? field : f)));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        this.customFieldError.set("Custom field names must be unique within a workspace.");
      } else {
        throw error;
      }
    }
  }

  async toggleFieldShowOnCard(id: string, current: boolean) {
    const field = await this.api.patch<WireCustomField>(`/custom-fields/${id}`, { showOnCard: !current });
    this.fields.update((items) => items.map((f) => (f.id === id ? field : f)));
  }

  async updateFieldIcon(id: string, icon: string) {
    const field = await this.api.patch<WireCustomField>(`/custom-fields/${id}`, { icon });
    this.fields.update((items) => items.map((f) => (f.id === id ? field : f)));
  }

  async toggleFieldAllowMultiple(id: string, current: boolean) {
    const field = await this.api.patch<WireCustomField>(`/custom-fields/${id}`, { allowMultiple: !current });
    this.fields.update((items) => items.map((f) => (f.id === id ? field : f)));
  }

  // ─── Select field options ──────────────────────────────────────────────────

  /** Apply a transform to one field's options, keeping them position-sorted. */
  private applyOptionChange(fieldId: string, update: (options: WireCustomFieldOption[]) => WireCustomFieldOption[]) {
    this.fields.update((items) =>
      items.map((field) =>
        field.id === fieldId
          ? { ...field, options: [...update(field.options)].sort((a, b) => Number(a.position) - Number(b.position)) }
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

  async addOption(fieldId: string) {
    const label = (this.newOptionLabel()[fieldId] ?? "").trim();
    if (!label) return;
    await this.api.post<WireCustomFieldOption>(`/custom-fields/${fieldId}/options`, {
      label,
      color: this.optionDraftColor(fieldId),
    });
    this.setNewOptionLabel(fieldId, "");
    this.setNewOptionColor(fieldId, null);
  }

  async renameOption(fieldId: string, optionId: string, label: string) {
    const trimmed = label.trim();
    if (!trimmed) return;
    const current = this.fields().find((f) => f.id === fieldId)?.options.find((o) => o.id === optionId);
    if (!current || current.label === trimmed) return;
    await this.api.patch<WireCustomFieldOption>(`/options/${optionId}`, { label: trimmed });
  }

  async recolorOption(fieldId: string, optionId: string, color: ColorToken | null) {
    this.applyOptionChange(fieldId, (options) => options.map((o) => (o.id === optionId ? { ...o, color } : o)));
    await this.api.patch<WireCustomFieldOption>(`/options/${optionId}`, { color });
  }

  async deleteOption(fieldId: string, optionId: string) {
    await this.api.delete(`/options/${optionId}`);
    this.applyOptionChange(fieldId, (options) => options.filter((o) => o.id !== optionId));
  }

  async dropOption(fieldId: string, event: CdkDragDrop<WireCustomFieldOption[]>) {
    if (event.previousIndex === event.currentIndex) return;
    const field = this.fields().find((f) => f.id === fieldId);
    if (!field) return;
    const moved = field.options[event.previousIndex];
    if (!moved) return;
    const reordered = [...field.options];
    reordered.splice(event.previousIndex, 1);
    reordered.splice(event.currentIndex, 0, moved);
    this.applyOptionChange(fieldId, () => reordered);

    const body =
      event.currentIndex === 0
        ? { beforeOptionId: reordered[1]?.id ?? null }
        : { afterOptionId: reordered[event.currentIndex - 1]?.id };
    await this.api.post(`/options/${moved.id}/move`, body);
  }

  async archiveField(id: string) {
    const field = this.fields().find((f) => f.id === id);
    if (!field) return;
    if (!await this.confirm.open({
      title: `Delete custom field "${field.name}"?`,
      message: "This will permanently remove the field and all its values from every card in this workspace.",
    })) return;
    await this.api.delete(`/custom-fields/${id}`);
    this.fields.update((items) => items.filter((f) => f.id !== id));
  }

  updateNewField(value: string) {
    this.customFieldError.set(null);
    this.newField.set(value);
  }

  private hasDuplicateFieldName(name: string) {
    const normalizedName = normalizeCustomFieldName(name);
    return this.fields().some((field) => normalizeCustomFieldName(field.name) === normalizedName);
  }

  async dropField(event: CdkDragDrop<WireCustomField[]>) {
    if (event.previousIndex === event.currentIndex) return;
    const items = this.fields();
    const moved = items[event.previousIndex];
    if (!moved) return;
    const reordered = [...items];
    reordered.splice(event.previousIndex, 1);
    reordered.splice(event.currentIndex, 0, moved);
    this.fields.set(reordered);

    const body =
      event.currentIndex === 0
        ? { beforeFieldId: reordered[1]?.id ?? null }
        : { afterFieldId: reordered[event.currentIndex - 1]?.id };
    await this.api.post(`/custom-fields/${moved.id}/move`, body);
  }

  // ─── Checklist templates ───────────────────────────────────────────────────

  private sortTemplates(templates: WireChecklistTemplate[]): WireChecklistTemplate[] {
    return [...templates].sort((a, b) => Number(a.position) - Number(b.position));
  }

  private replaceTemplate(template: WireChecklistTemplate) {
    this.templates.update((ts) => ts.map((t) => (t.id === template.id ? template : t)));
  }

  isTemplateExpanded(id: string): boolean {
    return this.expandedTemplateIds().has(id);
  }

  toggleTemplateExpanded(id: string) {
    this.expandedTemplateIds.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async addTemplate(e: Event) {
    e.preventDefault();
    const title = this.newTemplate().trim();
    if (!title) return;
    const template = await this.api.post<WireChecklistTemplate>(
      `/workspaces/${this.workspaceId()}/checklist-templates`,
      { title, items: [] },
    );
    this.templates.update((ts) => this.sortTemplates([...ts.filter((t) => t.id !== template.id), template]));
    this.newTemplate.set("");
    // Open the new template so the user can add items and pick lists right away.
    this.expandedTemplateIds.update((set) => new Set(set).add(template.id));
  }

  startEditTemplate(template: WireChecklistTemplate) {
    this.editingTemplateId.set(template.id);
    this.editingTemplateName.set(template.title);
  }

  cancelEditTemplate() {
    this.editingTemplateId.set(null);
  }

  async saveTemplateName(id: string) {
    const title = this.editingTemplateName().trim();
    this.editingTemplateId.set(null);
    if (!title) return;
    const current = this.templates().find((t) => t.id === id);
    if (!current || title === current.title) return;
    const template = await this.api.patch<WireChecklistTemplate>(`/checklist-templates/${id}`, { title });
    this.replaceTemplate(template);
  }

  async deleteTemplate(id: string) {
    const template = this.templates().find((t) => t.id === id);
    if (!template) return;
    if (!await this.confirm.open({
      title: `Delete template "${template.title}"?`,
      message: "New cards will no longer receive this checklist. Checklists already added to cards are kept.",
    })) return;
    await this.api.delete(`/checklist-templates/${id}`);
    this.templates.update((ts) => ts.filter((t) => t.id !== id));
  }

  newTemplateItemText(id: string): string {
    return this.newTemplateItem()[id] ?? "";
  }

  setNewTemplateItem(id: string, value: string) {
    this.newTemplateItem.update((map) => ({ ...map, [id]: value }));
  }

  private async saveTemplateItemTexts(id: string, texts: string[]) {
    const items = texts.map((t) => t.trim()).filter(Boolean);
    const updated = await this.api.patch<WireChecklistTemplate>(`/checklist-templates/${id}`, { items });
    this.replaceTemplate(updated);
  }

  async addTemplateItem(e: Event, id: string) {
    e.preventDefault();
    const text = this.newTemplateItemText(id).trim();
    if (!text) return;
    const template = this.templates().find((t) => t.id === id);
    if (!template) return;
    this.setNewTemplateItem(id, "");
    await this.saveTemplateItemTexts(id, [...template.items.map((i) => i.text), text]);
  }

  // Local-only edit of an item's text; persisted on blur via saveTemplateItem.
  updateTemplateItemText(id: string, index: number, value: string) {
    this.templates.update((ts) =>
      ts.map((t) =>
        t.id === id
          ? { ...t, items: t.items.map((item, i) => (i === index ? { ...item, text: value } : item)) }
          : t,
      ),
    );
  }

  async saveTemplateItem(id: string) {
    const template = this.templates().find((t) => t.id === id);
    if (!template) return;
    await this.saveTemplateItemTexts(id, template.items.map((i) => i.text));
  }

  async removeTemplateItem(id: string, index: number) {
    const template = this.templates().find((t) => t.id === id);
    if (!template) return;
    await this.saveTemplateItemTexts(id, template.items.filter((_, i) => i !== index).map((i) => i.text));
  }

  async dropTemplateItem(event: CdkDragDrop<unknown>, id: string) {
    if (event.previousIndex === event.currentIndex) return;
    const template = this.templates().find((t) => t.id === id);
    if (!template) return;
    const reordered = [...template.items];
    const [moved] = reordered.splice(event.previousIndex, 1);
    if (!moved) return;
    reordered.splice(event.currentIndex, 0, moved);
    // Optimistic reorder, then persist the new order via the coarse-grained items array.
    this.replaceTemplate({ ...template, items: reordered });
    await this.saveTemplateItemTexts(id, reordered.map((i) => i.text));
  }

  async dropTemplate(event: CdkDragDrop<WireChecklistTemplate[]>) {
    if (event.previousIndex === event.currentIndex) return;
    const items = this.templates();
    const moved = items[event.previousIndex];
    if (!moved) return;
    const reordered = [...items];
    reordered.splice(event.previousIndex, 1);
    reordered.splice(event.currentIndex, 0, moved);
    this.templates.set(reordered);

    const body =
      event.currentIndex === 0
        ? { beforeTemplateId: reordered[1]?.id ?? null }
        : { afterTemplateId: reordered[event.currentIndex - 1]?.id };
    const result = await this.api.post<{ id: string; position: string }>(`/checklist-templates/${moved.id}/move`, body);
    this.templates.update((ts) => this.sortTemplates(ts.map((t) => (t.id === result.id ? { ...t, position: result.position } : t))));
  }

  // ─── Automations ──────────────────────────────────────────────────────────

  private sortAutomations(automations: WireAutomation[]): WireAutomation[] {
    return [...automations].sort((a, b) => Number(a.position) - Number(b.position));
  }

  private replaceAutomation(automation: WireAutomation, preserveDraft = false) {
    const normalized = this.normalizeAutomation(automation);
    this.automations.update((items) => items.map((item) => (item.id === normalized.id ? normalized : item)));
    if (!preserveDraft && !this.hasIncompleteAutomationDraft(normalized.id) && this.automationActionDrafts()[normalized.id]) {
      this.automationActionDrafts.update((drafts) => ({ ...drafts, [normalized.id]: this.automationActionBodies(normalized) }));
    }
  }

  private defaultAutomationAction(): AutomationActionBody {
    return { type: "set_completion", config: { completed: true } };
  }

  private defaultActionForType(type: AutomationActionTypeName): AutomationActionBody {
    if (type === "add_labels" || type === "remove_labels") return { type, config: { labelIds: [] } };
    if (type === "add_assignees" || type === "remove_assignees") return { type, config: { userIds: [] } };
    if (type === "apply_checklists") return { type, config: { templateIds: [] } };
    if (type === "set_due_date") return { type, config: { offsetDays: 0, slot: "anyTime" } };
    if (type === "clear_due_date") return { type, config: {} };
    if (type === "move_to_list") return { type, config: { listId: this.lists()[0]?.id ?? "", placement: "bottom" } };
    if (type === "move_to_top" || type === "move_to_bottom") return { type, config: {} };
    if (type === "populate_custom_field") {
      const field = this.automationSetCustomFields()[0] ?? null;
      return { type, config: { fieldId: field?.id ?? "", onlyIfEmpty: true, value: this.defaultPopulateValueForField(field) } };
    }
    return { type: "set_completion", config: { completed: true } };
  }

  private defaultPopulateValueForField(field: WireCustomField | null): PopulateCustomFieldValue {
    if (!field || field.type === "text") return { kind: "text", text: "" };
    if (field.type === "number") return { kind: "number", number: 0 };
    if (field.type === "date") return { kind: "date", source: "current" };
    if (field.type === "checkbox") return { kind: "checkbox", checked: true };
    if (field.type === "select") return { kind: "select", optionIds: field.options[0]?.id ? [field.options[0].id] : [] };
    if (field.type === "user") return { kind: "user", userIds: this.automationMembers()[0]?.userId ? [this.automationMembers()[0]!.userId] : [] };
    return { kind: "text", text: "" };
  }

  isAutomationExpanded(id: string): boolean {
    return this.expandedAutomationIds().has(id);
  }

  toggleAutomationExpanded(id: string) {
    this.expandedAutomationIds.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    this.ensureAutomationDraft(id);
  }

  automationDraftActions(id: string): AutomationActionBody[] {
    const automation = this.automations().find((item) => item.id === id);
    return this.automationActionDrafts()[id] ?? (automation ? this.automationActionBodies(automation) : []);
  }

  canAddAutomationAction(id: string): boolean {
    return this.automationDraftActions(id).length < AUTOMATION_ACTION_LIMIT;
  }

  automationTriggerTypeValue(automation: WireAutomation): AutomationTriggerTypeName {
    return automation.triggerType === "due_date_arrives" || automation.triggerType === "all_checklist_items_complete" || automation.triggerType === "card_assigned_to_user" || automation.triggerType === "card_marked_complete" || automation.triggerType === "card_label_set" ? automation.triggerType : "card_enters_list";
  }

  automationTriggerListValue(automation: WireAutomation): string {
    return automation.triggerListId ?? "";
  }

  automationTriggerUserIds(automation: WireAutomation): string[] {
    return automation.triggerUserIds ?? [];
  }

  automationTriggerLabelId(automation: WireAutomation): string {
    return automation.triggerLabelId ?? "";
  }

  automationTriggerLabelMissing(automation: WireAutomation): boolean {
    return Boolean(automation.triggerLabelId) && !this.labels().some((label) => label.id === automation.triggerLabelId);
  }

  automationActionTypeValue(action: AutomationActionBody): string {
    return automationActionTypes.includes(action.type) ? action.type : "set_completion";
  }

  automationActionTargetValue(action: AutomationActionBody): string {
    if (action.type === "add_labels" || action.type === "remove_labels") return action.config.labelIds[0] ?? "";
    if (action.type === "add_assignees" || action.type === "remove_assignees") return action.config.userIds[0] ?? "";
    if (action.type === "move_to_list") return action.config.listId;
    if (action.type === "populate_custom_field") return action.config.fieldId;
    return "";
  }

  automationActionUserIds(action: AutomationActionBody): string[] {
    return action.type === "add_assignees" || action.type === "remove_assignees" ? action.config.userIds : [];
  }

  automationActionTemplateIds(action: AutomationActionBody): string[] {
    return action.type === "apply_checklists" ? action.config.templateIds : [];
  }

  automationMovePlacementValue(action: AutomationActionBody): "top" | "bottom" {
    return action.type === "move_to_list" && action.config.placement === "top" ? "top" : "bottom";
  }

  automationDueOffsetValue(action: AutomationActionBody): number {
    return action.type === "set_due_date" ? action.config.offsetDays : 0;
  }

  automationDueDatePresetValue(action: AutomationActionBody, automationId?: string, index?: number): AutomationDueDatePreset {
    if (automationId !== undefined && index !== undefined && this.customAutomationDueDateDrafts().has(this.automationActionDraftKey(automationId, index))) return "custom";
    const offsetDays = this.automationDueOffsetValue(action);
    return automationDueDatePresetOffsets.has(offsetDays) ? `${offsetDays}` as AutomationDueDatePreset : "custom";
  }

  isAutomationDueDateCustom(action: AutomationActionBody, automationId?: string, index?: number): boolean {
    return this.automationDueDatePresetValue(action, automationId, index) === "custom";
  }

  automationDueSlotValue(action: AutomationActionBody): DueDateSlot {
    return action.type === "set_due_date" ? action.config.slot : "anyTime";
  }

  automationDueSlotLabel(slot: DueDateSlot): string {
    if (slot === "anyTime") return "Any time";
    if (slot === "endOfWorkDay") return "End of workday";
    return slot.charAt(0).toUpperCase() + slot.slice(1);
  }

  automationCompletionValue(action: AutomationActionBody): string {
    return action.type === "set_completion" && !action.config.completed ? "false" : "true";
  }

  automationSetCustomField(action: AutomationActionBody): WireCustomField | null {
    return action.type === "populate_custom_field"
      ? this.fields().find((field) => field.id === action.config.fieldId) ?? null
      : null;
  }

  automationPopulateTextSource(action: AutomationActionBody): PopulateTextSource {
    return action.type === "populate_custom_field" && action.config.value.kind === "text_current_date" ? "current_date" : "text";
  }

  automationPopulateTextValue(action: AutomationActionBody): string {
    return action.type === "populate_custom_field" && action.config.value.kind === "text" ? action.config.value.text : "";
  }

  automationPopulateNumberValue(action: AutomationActionBody): string {
    return action.type === "populate_custom_field" && action.config.value.kind === "number" ? String(action.config.value.number) : "";
  }

  automationPopulateTextDateFormat(action: AutomationActionBody): PopulateTextDateFormat {
    return action.type === "populate_custom_field" && action.config.value.kind === "text_current_date" ? action.config.value.format : "date";
  }

  automationPopulateDateSource(action: AutomationActionBody): PopulateDateSource {
    return action.type === "populate_custom_field" && action.config.value.kind === "date" ? action.config.value.source : "current";
  }

  automationPopulateDateValue(action: AutomationActionBody): string {
    return action.type === "populate_custom_field" && action.config.value.kind === "date" && action.config.value.source === "fixed" ? action.config.value.date : "";
  }

  automationPopulateCheckboxValue(action: AutomationActionBody): string {
    return action.type === "populate_custom_field" && action.config.value.kind === "checkbox" && !action.config.value.checked ? "false" : "true";
  }

  automationPopulateOptionIds(action: AutomationActionBody): string[] {
    return action.type === "populate_custom_field" && action.config.value.kind === "select" ? action.config.value.optionIds : [];
  }

  automationPopulateFirstOptionId(action: AutomationActionBody): string {
    return this.automationPopulateOptionIds(action).at(0) ?? "";
  }

  automationPopulateUserIds(action: AutomationActionBody): string[] {
    return action.type === "populate_custom_field" && action.config.value.kind === "user" ? action.config.value.userIds : [];
  }

  automationPopulateFirstUserId(action: AutomationActionBody): string {
    return this.automationPopulateUserIds(action).at(0) ?? "";
  }

  automationPopulatePolicyValue(action: AutomationActionBody): string {
    return action.type === "populate_custom_field" && !action.config.onlyIfEmpty ? "overwrite" : "empty";
  }

  automationActionLabel(type: string): string {
    if (type === "move_to_top") return "move to top";
    if (type === "move_to_bottom") return "move to bottom";
    if (type === "apply_checklists") return "apply checklist";
    if (type === "populate_custom_field") return "set custom field";
    return type.replaceAll("_", " ");
  }

  automationTriggerLabel(automation: WireAutomation): string {
    if (automation.triggerType === "due_date_arrives") return "Due date arrives";
    if (automation.triggerType === "all_checklist_items_complete") return "All checklist items complete";
    if (automation.triggerType === "card_assigned_to_user") return this.automationTriggerTargetLabel(automation) ?? "Card assigned to selected users";
    if (automation.triggerType === "card_marked_complete") return "Card marked complete";
    if (automation.triggerType === "card_label_set") return `Label set to ${this.automationTriggerTargetLabel(automation) ?? "label"}`;
    const list = this.lists().find((item) => item.id === automation.triggerListId);
    return list ? `Card enters ${list.name}` : "Card enters list";
  }

  automationTriggerEventLabel(automation: WireAutomation): string {
    if (automation.triggerType === "due_date_arrives") return "Due date arrives";
    if (automation.triggerType === "all_checklist_items_complete") return "All checklist items complete";
    if (automation.triggerType === "card_assigned_to_user") return "Card assigned to";
    if (automation.triggerType === "card_marked_complete") return "Card marked complete";
    if (automation.triggerType === "card_label_set") return "Label set";
    if (automation.applyOnCreate && automation.applyOnMove) return "Card created or moved into";
    if (automation.applyOnCreate) return "Card created in";
    if (automation.applyOnMove) return "Card moved into";
    return "Paused";
  }

  automationTriggerTargetLabel(automation: WireAutomation): string | null {
    if (automation.triggerType === "due_date_arrives") return null;
    if (automation.triggerType === "all_checklist_items_complete") return null;
    if (automation.triggerType === "card_marked_complete") return null;
    if (automation.triggerType === "card_label_set") {
      return automation.triggerLabelId ? this.automationTriggerLabelName(automation.triggerLabelId) : "Choose label";
    }
    if (automation.triggerType === "card_assigned_to_user") {
      const names = this.automationTriggerUserIds(automation).map((id) => this.automationMemberName(id));
      if (names.length === 0) return "selected users";
      if (names.length <= 2) return names.join(", ");
      return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
    }
    return this.lists().find((item) => item.id === automation.triggerListId)?.name ?? "Choose list";
  }

  automationActionVerbLabel(action: AutomationActionBody): string {
    if (action.type === "add_labels") return "Add label";
    if (action.type === "remove_labels") return "Remove label";
    if (action.type === "add_assignees") return "Assign";
    if (action.type === "remove_assignees") return "Unassign";
    if (action.type === "apply_checklists") return "Apply checklist";
    if (action.type === "move_to_list") return "Move to list";
    if (action.type === "move_to_top") return "Move to top";
    if (action.type === "move_to_bottom") return "Move to bottom";
    if (action.type === "set_due_date") return "Set due date";
    if (action.type === "clear_due_date") return "Clear due date";
    if (action.type === "populate_custom_field") return "Set custom field";
    return action.config.completed ? "Mark complete" : "Mark incomplete";
  }

  automationActionTargetLabel(action: AutomationActionBody): string | null {
    if (action.type === "add_labels" || action.type === "remove_labels") {
      return action.config.labelIds[0] ? this.automationLabelName(action.config.labelIds[0]) : "Choose label";
    }
    if (action.type === "add_assignees" || action.type === "remove_assignees") {
      if (action.config.userIds.length === 0) return "Choose members";
      const names = action.config.userIds.map((id) => this.automationMemberName(id));
      if (names.length <= 2) return names.join(", ");
      return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
    }
    if (action.type === "apply_checklists") {
      if (action.config.templateIds.length === 0) return "Choose checklists";
      const names = action.config.templateIds.map((id) => this.automationTemplateName(id));
      if (names.length <= 2) return names.join(", ");
      return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
    }
    if (action.type === "move_to_list") {
      if (!action.config.listId) return "Choose list";
      const listName = this.lists().find((list) => list.id === action.config.listId)?.name ?? "list";
      return `${listName} · ${this.automationMovePlacementValue(action)}`;
    }
    if (action.type === "set_due_date") return this.automationDueDateSummary(action.config.offsetDays, action.config.slot);
    if (action.type === "populate_custom_field") {
      if (!action.config.fieldId) return "Choose custom field";
      return `${this.automationCustomFieldName(action.config.fieldId)} · ${this.automationPopulateValueLabel(action)}`;
    }
    return null;
  }

  isAutomationLabelAction(action: AutomationActionBody): boolean {
    return action.type === "add_labels" || action.type === "remove_labels";
  }

  automationActionLabelColor(action: AutomationActionBody): string | null {
    if (!this.isAutomationLabelAction(action)) return null;
    const labelId = this.automationActionTargetValue(action);
    const color = this.labels().find((label) => label.id === labelId)?.color;
    return color ? `var(--color-${color})` : "var(--border-strong)";
  }

  automationActionSummary(action: AutomationActionBody): string {
    if (action.type === "add_labels") return action.config.labelIds[0] ? `Add label ${this.automationLabelName(action.config.labelIds[0])}` : "Add label (choose label)";
    if (action.type === "remove_labels") return action.config.labelIds[0] ? `Remove label ${this.automationLabelName(action.config.labelIds[0])}` : "Remove label (choose label)";
    if (action.type === "add_assignees") return action.config.userIds.length ? `Assign ${this.automationActionTargetLabel(action)}` : "Assign (choose members)";
    if (action.type === "remove_assignees") return action.config.userIds.length ? `Unassign ${this.automationActionTargetLabel(action)}` : "Unassign (choose members)";
    if (action.type === "apply_checklists") return action.config.templateIds.length ? `Apply checklist ${this.automationActionTargetLabel(action)}` : "Apply checklist (choose checklists)";
    if (action.type === "move_to_list") {
      if (!action.config.listId) return "Move to list (choose list)";
      const listName = this.lists().find((list) => list.id === action.config.listId)?.name ?? "list";
      return `Move to ${listName} ${this.automationMovePlacementValue(action)}`;
    }
    if (action.type === "move_to_top") return "Move to top";
    if (action.type === "move_to_bottom") return "Move to bottom";
    if (action.type === "set_due_date") return `Set due date ${this.automationDueDateSummary(action.config.offsetDays, action.config.slot)}`;
    if (action.type === "clear_due_date") return "Clear due date";
    if (action.type === "populate_custom_field") {
      return action.config.fieldId
        ? `Set ${this.automationCustomFieldName(action.config.fieldId)} to ${this.automationPopulateValueLabel(action)}`
        : "Set custom field (choose field)";
    }
    return action.config.completed ? "Mark complete" : "Mark incomplete";
  }

  automationActionIcon(action: AutomationActionBody): string {
    if (action.type === "add_labels" || action.type === "remove_labels") return "ti-tag";
    if (action.type === "add_assignees" || action.type === "remove_assignees") return "ti-user";
    if (action.type === "apply_checklists") return "ti-list-check";
    if (action.type === "move_to_list") return "ti-arrow-right";
    if (action.type === "move_to_top") return "ti-arrow-up";
    if (action.type === "move_to_bottom") return "ti-arrow-down";
    if (action.type === "set_due_date" || action.type === "clear_due_date") return "ti-calendar";
    if (action.type === "populate_custom_field") return "ti-forms";
    return action.config.completed ? "ti-circle-check" : "ti-circle-dashed";
  }

  automationActionIconClass(action: AutomationActionBody): string {
    return `ti ${this.automationActionIcon(action)}`;
  }

  automationSummaryActions(automation: WireAutomation): AutomationActionBody[] {
    return this.automationActionDrafts()[automation.id] ?? this.automationActionBodies(automation);
  }

  private automationDueDateSummary(offsetDays: number, slot: DueDateSlot): string {
    const dayLabel =
      offsetDays === 0 ? "today"
        : offsetDays === 1 ? "tomorrow"
          : offsetDays === 7 ? "in 1 week"
            : offsetDays > 0 ? `in ${offsetDays} days`
              : `${Math.abs(offsetDays)} ${Math.abs(offsetDays) === 1 ? "day" : "days"} ago`;
    return slot === "anyTime" ? dayLabel : `${dayLabel}, ${this.automationDueSlotLabel(slot)}`;
  }

  automationLabelName(id: string): string {
    return this.labels().find((label) => label.id === id)?.name ?? "Label";
  }

  automationTriggerLabelName(id: string): string {
    return this.labels().find((label) => label.id === id)?.name ?? "Deleted label";
  }

  automationMemberName(id: string): string {
    return this.members().find((member) => member.userId === id)?.displayName ?? "Member";
  }

  automationTemplateName(id: string): string {
    return this.templates().find((template) => template.id === id)?.title ?? "Checklist";
  }

  automationCustomFieldName(id: string): string {
    return this.fields().find((field) => field.id === id)?.name ?? "Custom field";
  }

  automationPopulateTextDateFormatLabel(format: PopulateTextDateFormat): string {
    if (format === "date") return "YYYY-MM-DD";
    if (format === "month") return "YYYY-MM";
    if (format === "datetime") return "YYYY-MM-DD HH:mm";
    return "YYYY-MM-DD";
  }

  automationPopulateValueLabel(action: AutomationActionBody): string {
    if (action.type !== "populate_custom_field") return "";
    const value = action.config.value;
    if (value.kind === "text") return value.text || "Text";
    if (value.kind === "number") return String(value.number);
    if (value.kind === "text_current_date") return this.automationPopulateTextDateFormatLabel(value.format);
    if (value.kind === "date") return value.source === "current" ? "Current date" : value.date;
    if (value.kind === "checkbox") return value.checked ? "Checked" : "Unchecked";
    if (value.kind === "select") {
      const field = this.automationSetCustomField(action);
      const labels = value.optionIds.map((id) => field?.options.find((option) => option.id === id)?.label ?? "Option");
      if (labels.length === 0) return "Choose option";
      return labels.length <= 2 ? labels.join(", ") : `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
    }
    if (value.kind === "user") {
      const names = value.userIds.map((id) => this.automationMemberName(id));
      if (names.length === 0) return "Choose members";
      return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
    }
    return "";
  }

  private isAutomationActionComplete(action: AutomationActionBody): boolean {
    if (action.type === "add_labels" || action.type === "remove_labels") return action.config.labelIds.length > 0;
    if (action.type === "add_assignees" || action.type === "remove_assignees") return action.config.userIds.length > 0;
    if (action.type === "apply_checklists") return action.config.templateIds.length > 0;
    if (action.type === "move_to_list") return !!action.config.listId;
    if (action.type === "populate_custom_field") {
      if (!action.config.fieldId) return false;
      const field = this.automationSetCustomField(action);
      if (!field || !(automationSetCustomFieldTypes as readonly CustomFieldTypeName[]).includes(field.type)) return false;
      const value = action.config.value;
      if ((value.kind === "text" || value.kind === "text_current_date") && field.type !== "text") return false;
      if (value.kind === "number" && field.type !== "number") return false;
      if (value.kind === "date" && field.type !== "date") return false;
      if (value.kind === "checkbox" && field.type !== "checkbox") return false;
      if (value.kind === "select" && field.type !== "select") return false;
      if (value.kind === "user" && field.type !== "user") return false;
      if (value.kind === "text") return Boolean(value.text.trim());
      if (value.kind === "date" && value.source === "fixed") return /^\d{4}-\d{2}-\d{2}$/u.test(value.date);
      if (value.kind === "select") return value.optionIds.length > 0 && (field.allowMultiple || value.optionIds.length === 1);
      if (value.kind === "user") return value.userIds.length > 0 && (field.allowMultiple || value.userIds.length === 1);
      return true;
    }
    return true;
  }

  private hasIncompleteAutomationDraft(id: string): boolean {
    return this.automationActionDrafts()[id]?.some((action) => !this.isAutomationActionComplete(action)) ?? false;
  }

  private ensureAutomationDraft(id: string) {
    if (this.automationActionDrafts()[id]) return;
    const automation = this.automations().find((item) => item.id === id);
    if (!automation) return;
    this.automationActionDrafts.update((drafts) => ({
      ...drafts,
      [id]: this.automationActionBodies(automation),
    }));
  }

  private automationActionBodies(automation: WireAutomation): AutomationActionBody[] {
    return automation.actions.map((action) => this.automationActionBody(action));
  }

  private normalizeAutomation(automation: WireAutomation): WireAutomation {
    return {
      ...automation,
      triggerType: automation.triggerType === "due_date_arrives" || automation.triggerType === "all_checklist_items_complete" || automation.triggerType === "card_assigned_to_user" || automation.triggerType === "card_marked_complete" || automation.triggerType === "card_label_set" ? automation.triggerType : "card_enters_list",
      triggerListId: automation.triggerType === "card_enters_list" ? automation.triggerListId : null,
      triggerUserIds: automation.triggerType === "card_assigned_to_user" ? this.stringList(automation.triggerUserIds) : null,
      triggerLabelId: automation.triggerType === "card_label_set" ? automation.triggerLabelId : null,
      actions: automation.actions.map((action) => {
        const body = this.automationActionBody(action);
        return { ...action, type: body.type, config: body.config as WireAutomationAction["config"] };
      }),
    };
  }

  private automationActionBody(action: WireAutomationAction): AutomationActionBody {
      const config = this.automationActionConfig(action);
      if (action.type === "add_labels") {
        const labelIds = this.stringList(config["labelIds"] ?? config["labelId"]);
        return { type: "add_labels", config: { labelIds } };
      }
      if (action.type === "remove_labels") {
        const labelIds = this.stringList(config["labelIds"] ?? config["labelId"]);
        return { type: "remove_labels", config: { labelIds } };
      }
      if (action.type === "add_assignees") {
        const userIds = this.stringList(config["userIds"] ?? config["userId"]);
        return { type: "add_assignees", config: { userIds } };
      }
      if (action.type === "remove_assignees") {
        const userIds = this.stringList(config["userIds"] ?? config["userId"]);
        return { type: "remove_assignees", config: { userIds } };
      }
      if (action.type === "apply_checklists") {
        const templateIds = this.stringList(config["templateIds"] ?? config["templateId"]);
        return { type: "apply_checklists", config: { templateIds } };
      }
      if (action.type === "set_due_date") {
        const slotValue = config["slot"];
        const offsetDays = this.numberValue(config["offsetDays"], 0);
        const slot = this.dueDateSlots.includes(slotValue as DueDateSlot) ? slotValue as DueDateSlot : "anyTime";
        return { type: "set_due_date", config: { offsetDays, slot } };
      }
      if (action.type === "set_completion") {
        const completedValue = config["completed"];
        const completed = typeof completedValue === "boolean" ? completedValue : completedValue === "false" ? false : true;
        return { type: "set_completion", config: { completed } };
      }
      if (action.type === "move_to_list") {
        const listId = this.stringValue(config["listId"], "");
        const placement = config["placement"] === "top" ? "top" : "bottom";
        return { type: "move_to_list", config: { listId, placement } };
      }
      if (action.type === "populate_custom_field") {
        const fieldId = this.stringValue(config["fieldId"], "");
        const value = this.populateValueFromUnknown(config["value"], this.fields().find((field) => field.id === fieldId) ?? null);
        return {
          type: "populate_custom_field",
          config: {
            fieldId,
            onlyIfEmpty: config["onlyIfEmpty"] !== false,
            value,
          },
        };
      }
      if (action.type === "move_to_top") return { type: "move_to_top", config: {} };
      if (action.type === "move_to_bottom") return { type: "move_to_bottom", config: {} };
      const emptyConfig: Record<string, never> = {};
      return { type: "clear_due_date", config: emptyConfig };
  }

  private automationActionConfig(action: WireAutomationAction): Record<string, unknown> {
    const actionWithUnknowns = action as WireAutomationAction & Record<string, unknown>;
    return isRecord(action.config) ? action.config : actionWithUnknowns;
  }

  private stringList(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0);
    return typeof value === "string" && value.length > 0 ? [value] : [];
  }

  private stringValue(value: unknown, fallback: string): string {
    return typeof value === "string" ? value : fallback;
  }

  private numberValue(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  }

  private booleanValue(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
  }

  private populateValueFromUnknown(value: unknown, field: WireCustomField | null): PopulateCustomFieldValue {
    if (!isRecord(value)) return this.defaultPopulateValueForField(field);
    const kind = value["kind"];
    if (kind === "text") return { kind, text: this.stringValue(value["text"], "") };
    if (kind === "number") return { kind, number: typeof value["number"] === "number" && Number.isFinite(value["number"]) ? value["number"] : 0 };
    if (kind === "text_current_date") {
      const format = automationTextDateFormats.includes(value["format"] as PopulateTextDateFormat) ? value["format"] as PopulateTextDateFormat : "date";
      return { kind, format };
    }
    if (kind === "date") {
      return value["source"] === "fixed"
        ? { kind, source: "fixed", date: this.stringValue(value["date"], "") }
        : { kind, source: "current" };
    }
    if (kind === "checkbox") return { kind, checked: this.booleanValue(value["checked"], true) };
    if (kind === "select") return { kind, optionIds: this.stringList(value["optionIds"]) };
    if (kind === "user") return { kind, userIds: this.stringList(value["userIds"]) };
    return this.defaultPopulateValueForField(field);
  }

  private setAutomationDraftAction(id: string, index: number, action: AutomationActionBody) {
    const actions = [...this.automationDraftActions(id)];
    actions[index] = action;
    this.automationActionDrafts.update((drafts) => ({ ...drafts, [id]: actions }));
  }

  private automationActionDraftKey(id: string, index: number): string {
    return `${id}:${index}`;
  }

  async addAutomation(e: Event) {
    e.preventDefault();
    const listId = this.lists()[0]?.id ?? null;
    if (!listId || this.automationLimitReached()) return;
    const automation = await this.api.post<WireAutomation>(`/workspaces/${this.workspaceId()}/automations`, {
      triggerType: "card_enters_list",
      triggerListId: listId,
      applyOnCreate: true,
      applyOnMove: true,
      actions: [this.defaultAutomationAction()],
    });
    const normalized = this.normalizeAutomation(automation);
    this.automations.update((items) => this.sortAutomations([...items.filter((item) => item.id !== normalized.id), normalized]));
    this.expandedAutomationIds.update((set) => new Set(set).add(normalized.id));
    this.ensureAutomationDraft(normalized.id);
  }

  async toggleAutomationEnabled(automation: WireAutomation) {
    const current = this.automations().find((item) => item.id === automation.id) ?? automation;
    if (!this.canToggleAutomationEnabled(current)) return;
    const enabled = !current.enabled;
    this.replaceAutomation({ ...current, enabled });
    const updated = await this.api.patch<WireAutomation>(`/automations/${current.id}`, { enabled });
    this.replaceAutomation(updated);
  }

  canToggleAutomationEnabled(automation: WireAutomation): boolean {
    if (automation.enabled) return true; // turning off is always allowed
    // Enabling requires at least one action and, on a capped plan, headroom under the limit.
    return automation.actions.length > 0 && this.canEnableAutomation(automation.id);
  }

  private canEnableAutomation(automationId: string): boolean {
    const max = this.auth.maxEnabledAutomations();
    if (max === null) return true;
    return this.automations().filter((automation) => automation.enabled && automation.id !== automationId).length < max;
  }

  async updateAutomationTrigger(id: string, triggerType: AutomationTriggerTypeName) {
    const current = this.automations().find((automation) => automation.id === id);
    if (!current) return;
    const triggerListId = triggerType === "card_enters_list" ? (current.triggerListId ?? this.lists()[0]?.id ?? null) : null;
    const triggerUserIds = triggerType === "card_assigned_to_user" ? (current.triggerUserIds?.length ? current.triggerUserIds : [this.automationMembers()[0]?.userId].filter((userId): userId is string => Boolean(userId))) : null;
    const triggerLabelId = triggerType === "card_label_set" ? (current.triggerLabelId ?? this.labels()[0]?.id ?? null) : null;
    if (triggerType === "card_label_set" && !triggerLabelId) return;
    const updated = await this.api.patch<WireAutomation>(`/automations/${id}`, { triggerType, triggerListId, triggerUserIds, triggerLabelId });
    this.replaceAutomation(updated);
  }

  async updateAutomationTriggerList(id: string, triggerListId: string) {
    const updated = await this.api.patch<WireAutomation>(`/automations/${id}`, { triggerListId });
    this.replaceAutomation(updated);
  }

  async toggleAutomationTriggerUser(id: string, userId: string) {
    const current = this.automations().find((automation) => automation.id === id);
    if (!current) return;
    const ids = new Set(current.triggerUserIds ?? []);
    if (ids.has(userId)) ids.delete(userId);
    else ids.add(userId);
    if (ids.size === 0) return;
    const updated = await this.api.patch<WireAutomation>(`/automations/${id}`, { triggerUserIds: Array.from(ids) });
    this.replaceAutomation(updated);
  }

  async updateAutomationTriggerUsers(id: string, triggerUserIds: string[]) {
    if (triggerUserIds.length === 0) return;
    const updated = await this.api.patch<WireAutomation>(`/automations/${id}`, { triggerUserIds });
    this.replaceAutomation(updated);
  }

  async updateAutomationTriggerLabel(id: string, triggerLabelId: string) {
    if (!triggerLabelId) return;
    const updated = await this.api.patch<WireAutomation>(`/automations/${id}`, { triggerLabelId });
    this.replaceAutomation(updated);
  }

  async toggleAutomationApply(id: string, field: "applyOnCreate" | "applyOnMove") {
    const current = this.automations().find((automation) => automation.id === id);
    if (!current) return;
    const updated = await this.api.patch<WireAutomation>(`/automations/${id}`, { [field]: !current[field] });
    this.replaceAutomation(updated);
  }

  addAutomationAction(id: string) {
    if (!this.canAddAutomationAction(id)) return;
    const actions = [...this.automationDraftActions(id), this.defaultAutomationAction()];
    this.automationActionDrafts.update((drafts) => ({ ...drafts, [id]: actions }));
    void this.saveAutomationActions(id);
  }

  removeAutomationAction(id: string, index: number) {
    const actions = this.automationDraftActions(id).filter((_, itemIndex) => itemIndex !== index);
    this.automationActionDrafts.update((drafts) => ({ ...drafts, [id]: actions }));
    void this.saveAutomationActions(id);
  }

  updateAutomationActionType(id: string, index: number, type: AutomationActionTypeName) {
    this.setAutomationDraftAction(id, index, this.defaultActionForType(type));
    void this.saveAutomationActions(id);
  }

  updateAutomationActionTarget(id: string, index: number, value: string) {
    const action = this.automationDraftActions(id)[index];
    if (!action) return;
    if (action.type === "add_labels" || action.type === "remove_labels") {
      this.setAutomationDraftAction(id, index, { type: action.type, config: { labelIds: value ? [value] : [] } });
    } else if (action.type === "add_assignees" || action.type === "remove_assignees") {
      this.setAutomationDraftAction(id, index, { type: action.type, config: { userIds: value ? [value] : [] } });
    } else if (action.type === "apply_checklists") {
      this.setAutomationDraftAction(id, index, { type: action.type, config: { templateIds: value ? [value] : [] } });
    } else if (action.type === "move_to_list") {
      this.setAutomationDraftAction(id, index, { type: action.type, config: { ...action.config, listId: value } });
    } else if (action.type === "populate_custom_field") {
      const field = this.fields().find((candidate) => candidate.id === value) ?? null;
      this.setAutomationDraftAction(id, index, { type: action.type, config: { ...action.config, fieldId: value, value: this.defaultPopulateValueForField(field) } });
    }
    void this.saveAutomationActions(id);
  }

  updateAutomationActionAssignees(id: string, index: number, userIds: string[]) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "add_assignees" && action?.type !== "remove_assignees") return;
    this.setAutomationDraftAction(id, index, { type: action.type, config: { userIds } });
    void this.saveAutomationActions(id);
  }

  updateAutomationActionTemplates(id: string, index: number, templateIds: string[]) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "apply_checklists") return;
    this.setAutomationDraftAction(id, index, { type: "apply_checklists", config: { templateIds } });
    void this.saveAutomationActions(id);
  }

  updateAutomationMovePlacement(id: string, index: number, placement: string) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "move_to_list") return;
    this.setAutomationDraftAction(id, index, {
      type: "move_to_list",
      config: { ...action.config, placement: placement === "top" ? "top" : "bottom" },
    });
    void this.saveAutomationActions(id);
  }

  updateAutomationDueOffset(id: string, index: number, offsetDays: number) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "set_due_date") return;
    this.setAutomationDraftAction(id, index, { type: "set_due_date", config: { ...action.config, offsetDays } });
    void this.saveAutomationActions(id);
  }

  updateAutomationDueDatePreset(id: string, index: number, preset: AutomationDueDatePreset) {
    const key = this.automationActionDraftKey(id, index);
    if (preset === "custom") {
      this.customAutomationDueDateDrafts.update((keys) => new Set(keys).add(key));
      return;
    }
    this.customAutomationDueDateDrafts.update((keys) => {
      const next = new Set(keys);
      next.delete(key);
      return next;
    });
    this.updateAutomationDueOffset(id, index, Number(preset));
  }

  updateAutomationDueSlot(id: string, index: number, slot: DueDateSlot) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "set_due_date") return;
    this.setAutomationDraftAction(id, index, { type: "set_due_date", config: { ...action.config, slot } });
    void this.saveAutomationActions(id);
  }

  updateAutomationCompletion(id: string, index: number, completed: boolean) {
    this.setAutomationDraftAction(id, index, { type: "set_completion", config: { completed } });
    void this.saveAutomationActions(id);
  }

  updateAutomationPopulatePolicy(id: string, index: number, policy: string) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "populate_custom_field") return;
    this.setAutomationDraftAction(id, index, {
      type: "populate_custom_field",
      config: { ...action.config, onlyIfEmpty: policy !== "overwrite" },
    });
    void this.saveAutomationActions(id);
  }

  toggleAutomationPopulatePolicy(id: string, index: number) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "populate_custom_field") return;
    this.updateAutomationPopulatePolicy(id, index, action.config.onlyIfEmpty ? "overwrite" : "empty");
  }

  updateAutomationPopulateTextSource(id: string, index: number, source: PopulateTextSource) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "populate_custom_field") return;
    this.setAutomationDraftAction(id, index, {
      type: "populate_custom_field",
      config: {
        ...action.config,
        value: source === "current_date"
          ? { kind: "text_current_date", format: "date" }
          : { kind: "text", text: action.config.value.kind === "text" ? action.config.value.text : "" },
      },
    });
    void this.saveAutomationActions(id);
  }

  updateAutomationPopulateTextDateFormat(id: string, index: number, format: PopulateTextDateFormat) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "populate_custom_field") return;
    const nextFormat = automationTextDateFormats.includes(format) ? format : "date";
    this.setAutomationDraftAction(id, index, {
      type: "populate_custom_field",
      config: { ...action.config, value: { kind: "text_current_date", format: nextFormat } },
    });
    void this.saveAutomationActions(id);
  }

  updateAutomationPopulateText(id: string, index: number, valueText: string) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "populate_custom_field") return;
    this.setAutomationDraftAction(id, index, {
      type: "populate_custom_field",
      config: { ...action.config, value: { kind: "text", text: valueText } },
    });
    void this.saveAutomationActions(id);
  }

  updateAutomationPopulateNumber(id: string, index: number, raw: string) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "populate_custom_field") return;
    // Empty/invalid input falls back to 0 so the action stays complete and savable.
    const parsed = Number(raw);
    const number = raw.trim() !== "" && Number.isFinite(parsed) ? parsed : 0;
    this.setAutomationDraftAction(id, index, {
      type: "populate_custom_field",
      config: { ...action.config, value: { kind: "number", number } },
    });
    void this.saveAutomationActions(id);
  }

  updateAutomationPopulateDateSource(id: string, index: number, source: PopulateDateSource) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "populate_custom_field") return;
    this.setAutomationDraftAction(id, index, {
      type: "populate_custom_field",
      config: {
        ...action.config,
        value: source === "fixed"
          ? { kind: "date", source: "fixed", date: action.config.value.kind === "date" && action.config.value.source === "fixed" ? action.config.value.date : "" }
          : { kind: "date", source: "current" },
      },
    });
    void this.saveAutomationActions(id);
  }

  updateAutomationPopulateDate(id: string, index: number, date: string) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "populate_custom_field") return;
    this.setAutomationDraftAction(id, index, {
      type: "populate_custom_field",
      config: { ...action.config, value: { kind: "date", source: "fixed", date } },
    });
    void this.saveAutomationActions(id);
  }

  updateAutomationPopulateCheckbox(id: string, index: number, checked: boolean) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "populate_custom_field") return;
    this.setAutomationDraftAction(id, index, {
      type: "populate_custom_field",
      config: { ...action.config, value: { kind: "checkbox", checked } },
    });
    void this.saveAutomationActions(id);
  }

  updateAutomationPopulateIds(id: string, index: number, kind: "select" | "user", ids: string[]) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "populate_custom_field") return;
    const field = this.automationSetCustomField(action);
    const nextIds = field?.allowMultiple ? ids : ids.slice(0, 1);
    this.setAutomationDraftAction(id, index, {
      type: "populate_custom_field",
      config: {
        ...action.config,
        value: kind === "select" ? { kind, optionIds: nextIds } : { kind, userIds: nextIds },
      },
    });
    void this.saveAutomationActions(id);
  }

  selectedOptionValues(options: HTMLCollectionOf<HTMLOptionElement>): string[] {
    return Array.from(options).filter((option) => option.selected).map((option) => option.value).filter(Boolean);
  }

  async saveAutomationActions(id: string) {
    const actions = this.automationDraftActions(id).filter((action) => this.isAutomationActionComplete(action));
    const automation = await this.api.put<WireAutomation>(`/automations/${id}/actions`, { actions });
    this.replaceAutomation(automation, true);
  }

  async dropAutomationAction(event: CdkDragDrop<unknown>, id: string) {
    if (event.previousIndex === event.currentIndex) return;
    const actions = [...this.automationDraftActions(id)];
    const [moved] = actions.splice(event.previousIndex, 1);
    if (!moved) return;
    actions.splice(event.currentIndex, 0, moved);
    this.automationActionDrafts.update((drafts) => ({ ...drafts, [id]: actions }));
    await this.saveAutomationActions(id);
  }

  async dropAutomation(event: CdkDragDrop<WireAutomation[]>) {
    if (event.previousIndex === event.currentIndex) return;
    const items = this.automations();
    const moved = items[event.previousIndex];
    if (!moved) return;
    const reordered = [...items];
    reordered.splice(event.previousIndex, 1);
    reordered.splice(event.currentIndex, 0, moved);
    this.automations.set(reordered);
    const body =
      event.currentIndex === 0
        ? { beforeAutomationId: reordered[1]?.id ?? null }
        : { afterAutomationId: reordered[event.currentIndex - 1]?.id };
    const result = await this.api.post<{ id: string; position: string }>(`/automations/${moved.id}/move`, body);
    this.automations.update((items) => this.sortAutomations(items.map((item) => (item.id === result.id ? { ...item, position: result.position } : item))));
  }

  async deleteAutomation(id: string) {
    const automation = this.automations().find((item) => item.id === id);
    if (!automation) return;
    if (!await this.confirm.open({
      title: "Delete automation?",
      message: "Future cards will no longer run this automation. Existing card changes are kept.",
    })) return;
    await this.api.delete(`/automations/${id}`);
    this.automations.update((items) => items.filter((item) => item.id !== id));
  }

  async addLabel(e: Event) {
    e.preventDefault();
    const name = this.newLabel().trim();
    if (!name) return;
    await this.api.post<WireCardLabel>(`/workspaces/${this.workspaceId()}/card-labels`, {
      name,
      color: this.newLabelColor() ?? undefined,
    });
    this.newLabel.set("");
    this.newLabelColor.set(null);
  }

  async archiveLabel(id: string) {
    const label = this.labels().find((l) => l.id === id);
    if (!label) return;
    if (!await this.confirm.open({ title: `Delete label "${label.name}"?`, message: "This cannot be undone." })) return;
    await this.api.delete(`/card-labels/${id}`);
    this.labels.update((items) => items.filter((l) => l.id !== id));
  }

  startEditLabel(label: WireCardLabel) {
    this.editingLabelId.set(label.id);
    this.editingLabelName.set(label.name);
  }

  cancelEditLabel() {
    this.editingLabelId.set(null);
  }

  async saveLabelName(id: string) {
    const name = this.editingLabelName().trim();
    this.editingLabelId.set(null);
    if (!name) return;
    const current = this.labels().find((l) => l.id === id);
    if (!current || name === current.name) return;
    const label = await this.api.patch<WireCardLabel>(`/card-labels/${id}`, { name });
    this.labels.update((items) => items.map((l) => (l.id === id ? label : l)));
  }

  async updateLabelColor(id: string, color: ColorToken | null) {
    const label = await this.api.patch<WireCardLabel>(`/card-labels/${id}`, { color });
    this.labels.update((items) => items.map((l) => (l.id === id ? label : l)));
  }

  async dropLabel(event: CdkDragDrop<WireCardLabel[]>) {
    if (event.previousIndex === event.currentIndex) return;
    const items = this.labels();
    const moved = items[event.previousIndex];
    if (!moved) return;
    const reordered = [...items];
    reordered.splice(event.previousIndex, 1);
    reordered.splice(event.currentIndex, 0, moved);
    this.labels.set(reordered);

    const body =
      event.currentIndex === 0
        ? { beforeLabelId: reordered[1]?.id ?? null }
        : { afterLabelId: reordered[event.currentIndex - 1]?.id };
    await this.api.post(`/card-labels/${moved.id}/move`, body);
  }

  async updateMemberRole(userId: string, role: WorkspaceRole) {
    const existing = this.members().find((m) => m.userId === userId);
    if (!existing) return;
    if (!this.canControlOwners() && (existing.role === "owner" || role === "owner")) return;
    const member = await this.api.patch<MemberRow>(`/workspaces/${this.workspaceId()}/members/${userId}`, { role });
    this.members.update((rows) => rows.map((r) => (r.userId === userId ? { ...r, role: member.role } : r)));
  }

  async addMember(e: Event) {
    e.preventDefault();
    const userId = this.addMemberUserId();
    if (!userId) return;
    if (!this.canControlOwners() && this.addMemberRole() === "owner") return;
    const member = await this.api.post<MemberRow>(`/workspaces/${this.workspaceId()}/members`, {
      userId,
      role: this.addMemberRole(),
    });
    this.members.update((rows) => rows.some((row) => row.userId === member.userId) ? rows : [...rows, member]);
    this.addMemberUserId.set("");
    this.addMemberRole.set("editor");
  }

  async removeMember(userId: string) {
    const member = this.members().find((m) => m.userId === userId);
    if (!member) return;
    if (!this.canControlOwners() && member.role === "owner") return;
    if (!await this.confirm.open({
      title: `Remove ${member.displayName}?`,
      message: "They will lose access to this workspace and all its boards.",
    })) return;
    await this.api.delete(`/workspaces/${this.workspaceId()}/members/${userId}`);
    this.members.update((rows) => rows.filter((r) => r.userId !== userId));
  }

  async inviteGuest(e: Event) {
    e.preventDefault();
    await this.submitGuestInvite();
  }

  private async submitGuestInvite() {
    const boardId = this.guestBoardId();
    const email = this.guestEmail().trim();
    if (!boardId || !email || this.guestBusy()) return;
    if (this.duplicatePendingGuestInvite()) {
      this.guestError.set("There is already a pending invite for this email and board.");
      return;
    }
    this.guestBusy.set(true);
    this.guestError.set(null);
    try {
      const preview = await this.api.post<GuestSeatPreviewResponse>(`/workspaces/${this.workspaceId()}/guests/seat-preview`, {
        boardId,
        email,
        role: this.guestRole(),
      });
      if (preview.paidGuestSeatRequired) {
        // Paid guest seats come from the org's pre-purchased pool. Explain that before the mutation,
        // because the next request will allocate the seat immediately for existing external users.
        const confirmed = await this.confirm.open({
          title: "This guest will use a paid seat",
          message: "Adding this guest to another board will put them over the free guest limit, so Kanera will assign one of your purchased seats to them. Your bill will not change right now, but one available seat will be used until their guest access is back within the free limit.",
          confirmLabel: "Use seat",
          danger: false,
        });
        if (!confirmed) return;
      }
      const result = await this.api.post<{
        status: "added" | "invited";
        guest?: AcceptedGuestRow | null;
        invite?: PendingGuestInviteRow;
        token?: string;
      }>(`/workspaces/${this.workspaceId()}/guests/invitations`, {
        boardId,
        email,
        role: this.guestRole(),
      });
      if (result.guest) {
        this.acceptedGuests.update((rows) => {
          const nextRows = rows
            .filter((row) => !(row.boardId === result.guest!.boardId && row.userId === result.guest!.userId))
            .map((row) => row.userId === result.guest!.userId && result.guest!.paidGuestSeat ? { ...row, paidGuestSeat: true } : row);
          return [...nextRows, result.guest!];
        });
      }
      if (result.invite) {
        const inviteUrl = result.token ? `${location.origin}/board-invite?token=${encodeURIComponent(result.token)}` : result.invite.url;
        const invite = inviteUrl ? { ...result.invite, url: inviteUrl } : result.invite;
        this.pendingGuestInvites.update((rows) => {
          const matchIndex = rows.findIndex((row) => row.id === invite.id);
          if (matchIndex === -1) return [...rows, invite];
          const next = [...rows];
          const existing = next[matchIndex]!;
          const existingBoards = existing.boards ?? [{ boardId: existing.boardId, boardName: existing.boardName, role: existing.role }];
          const addedBoards = invite.boards ?? [{ boardId: invite.boardId, boardName: invite.boardName, role: invite.role }];
          const boardMap = new Map(existingBoards.map((board) => [board.boardId, board]));
          for (const board of addedBoards) boardMap.set(board.boardId, board);
          next[matchIndex] = {
            ...existing,
            ...invite,
            url: invite.url ?? existing.url,
            boardId: existing.boardId,
            boardName: existing.boardName,
            role: existing.role,
            boards: [...boardMap.values()],
          };
          return next;
        });
        if (inviteUrl) {
          this.createdGuestInviteUrl.set(inviteUrl);
          this.guestInviteCopied.set(false);
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            await navigator.clipboard.writeText(inviteUrl).then(() => this.guestInviteCopied.set(true)).catch(() => { });
          }
        }
      } else {
        this.createdGuestInviteUrl.set(null);
        this.guestInviteCopied.set(false);
      }
      this.guestEmail.set("");
      this.guestRole.set("editor");
    } catch (error) {
      // Block-until-buy: a full seat pool means the admin must purchase more seats first. Point them at
      // the plan page rather than the generic error so the next step is obvious.
      if (isSeatLimitReached(error)) {
        this.guestError.set("Adding this guest needs a seat, but all purchased seats are in use. Buy more seats on the Account Plan page, then try again.");
        return;
      }
      this.guestError.set(extractErrorMessage(error));
    } finally {
      this.guestBusy.set(false);
    }
  }

  async copyGuestInviteUrl(value: string | null) {
    if (!value || typeof navigator === "undefined") return;
    await navigator.clipboard?.writeText(value);
    this.guestInviteCopied.set(true);
  }

  async removeGuest(boardId: string, userId: string) {
    const guest = this.acceptedGuests().find((row) => row.boardId === boardId && row.userId === userId);
    if (!guest) return;
    if (!await this.confirm.open({
      title: `Remove ${guest.displayName}?`,
      message: `They will lose access to "${guest.boardName}".`,
    })) return;
    const key = `${boardId}:${userId}`;
    this.guestRemovingId.set(key);
    this.guestError.set(null);
    try {
      const result = await this.api.delete<RemoveGuestResponse>(`/workspaces/${this.workspaceId()}/guests/${boardId}/${userId}`);
      this.acceptedGuests.update((rows) =>
        rows
          .filter((row) => !(row.boardId === boardId && row.userId === userId))
          .map((row) => row.userId === userId && result?.paidGuestSeatRemoved ? { ...row, paidGuestSeat: false } : row),
      );
    } catch (error) {
      this.guestError.set(extractErrorMessage(error));
    } finally {
      this.guestRemovingId.set(null);
    }
  }

  async revokeGuestInvite(invitationId: string) {
    const invite = this.pendingGuestInvites().find((row) => row.id === invitationId);
    if (!invite) return;
    if (!await this.confirm.open({
      title: `Revoke invite for ${invite.email}?`,
      message: `This invitation to ${this.pendingInviteBoardLabel(invite)} will stop working.`,
    })) return;
    this.guestRemovingId.set(invitationId);
    this.guestError.set(null);
    try {
      await this.api.delete(`/workspaces/${this.workspaceId()}/guests/invitations/${invitationId}`);
      this.pendingGuestInvites.update((rows) => rows.filter((row) => row.id !== invitationId));
    } catch (error) {
      this.guestError.set(extractErrorMessage(error));
    } finally {
      this.guestRemovingId.set(null);
    }
  }

  pendingInviteBoardLabel(invite: PendingGuestInviteRow): string {
    const boards = invite.boards ?? [{ boardId: invite.boardId, boardName: invite.boardName, role: invite.role }];
    return boards.map((board) => board.boardName).join(", ");
  }

  async deleteWorkspace() {
    const ws = this.workspace();
    if (!ws) return;
    if (!this.canControlOwners()) return;
    if (!await this.confirm.open({
      title: `Delete workspace "${ws.name}"?`,
      message: "This will permanently delete all boards, lists, and cards inside it.",
    })) return;
    await this.api.delete(`/workspaces/${this.workspaceId()}`);
    const remainingWorkspaces = await this.api.get<Workspace[]>("/workspaces");
    const hasWorkspace = remainingWorkspaces.length > 0;
    this.auth.updateUser((u) => ({ ...u, hasWorkspace }));
    await this.router.navigateByUrl(hasWorkspace ? "/" : "/onboarding");
  }

  // ─── Board management ──────────────────────────────────────────────────────

  async createBoardGroup(e: Event) {
    e.preventDefault();
    const title = this.newBoardGroupTitle().trim();
    if (!title) return;
    const group = await this.api.post<BoardGroup>(`/workspaces/${this.workspaceId()}/board-groups`, { title });
    this.boardGroups.update((groups) => sortBoardGroups([...groups.filter((g) => g.id !== group.id), group]));
    this.newBoardGroupTitle.set("");
  }

  startEditBoardGroup(group: BoardGroup) {
    this.editingBoardGroupId.set(group.id);
    this.editingBoardGroupTitle.set(group.title);
  }

  cancelEditBoardGroup() {
    this.editingBoardGroupId.set(null);
  }

  async saveBoardGroupTitle(id: string) {
    const title = this.editingBoardGroupTitle().trim();
    this.editingBoardGroupId.set(null);
    if (!title) return;
    const current = this.boardGroups().find((g) => g.id === id);
    if (!current || current.title === title) return;
    const group = await this.api.patch<BoardGroup>(`/board-groups/${id}`, { title });
    this.boardGroups.update((groups) => sortBoardGroups(groups.map((g) => g.id === id ? group : g)));
  }

  async deleteBoardGroup(id: string) {
    const group = this.boardGroups().find((g) => g.id === id);
    if (!group) return;
    if (!await this.confirm.open({
      title: `Delete "${group.title}"?`,
      message: "Boards in this group will move to Ungrouped.",
    })) return;
    await this.api.delete(`/board-groups/${id}`);
  }

  async dropBoardGroup(event: CdkDragDrop<BoardGroup[]>) {
    if (event.previousIndex === event.currentIndex) return;
    const items = this.boardGroups();
    const moved = items[event.previousIndex];
    if (!moved) return;
    const reordered = [...items];
    reordered.splice(event.previousIndex, 1);
    reordered.splice(event.currentIndex, 0, moved);
    this.boardGroups.set(reordered);

    const body =
      event.currentIndex === 0
        ? { beforeGroupId: reordered[1]?.id ?? null }
        : { afterGroupId: reordered[event.currentIndex - 1]?.id };
    const result = await this.api.post<{ id: string; position: string }>(`/board-groups/${moved.id}/move`, body);
    this.boardGroups.update((groups) => sortBoardGroups(groups.map((g) => g.id === result.id ? { ...g, position: result.position } : g)));
  }

  async createBoard(e: Event) {
    e.preventDefault();
    const name = this.newBoardName().trim();
    if (!name) return;
    const board = await this.api.post<Board>(`/workspaces/${this.workspaceId()}/boards`, { name, visibility: "workspace" });
    this.boardList.update((bs) => bs.some((b) => b.id === board.id) ? bs : sortBoards([...bs, board]));
    this.upsertGuestBoard(board);
    this.newBoardName.set("");
  }

  async updateBoardGroup(id: string, groupId: string | null) {
    this.boardList.update((bs) => bs.map((b) => (b.id === id ? { ...b, groupId } : b)));
    const board = await this.api.patch<Board>(`/boards/${id}`, { groupId });
    this.boardList.update((bs) => bs.map((b) => (b.id === id ? board : b)));
  }

  startEditBoard(board: Board) {
    this.editingBoardId.set(board.id);
    this.editingBoardName.set(board.name);
  }

  cancelEditBoard() {
    this.editingBoardId.set(null);
  }

  async saveBoardName(id: string) {
    const name = this.editingBoardName().trim();
    this.editingBoardId.set(null);
    if (!name) return;
    const current = this.boardList().find((b) => b.id === id);
    if (!current || name === current.name) return;
    const board = await this.api.patch<Board>(`/boards/${id}`, { name });
    this.boardList.update((bs) => bs.map((b) => (b.id === id ? board : b)));
    this.updateGuestBoard(board);
  }

  async updateBoardIcon(id: string, icon: string) {
    this.boardList.update((bs) => bs.map((b) => (b.id === id ? { ...b, icon } : b)));
    await this.api.patch<Board>(`/boards/${id}`, { icon });
    this.guestBoards.update((boards) => boards.map((board) => board.id === id ? { ...board, icon } : board));
  }

  async updateBoardColor(id: string, iconColor: ColorToken | null) {
    this.boardList.update((bs) => bs.map((b) => (b.id === id ? { ...b, iconColor } : b)));
    const board = await this.api.patch<Board>(`/boards/${id}`, { iconColor });
    this.boardList.update((bs) => bs.map((b) => (b.id === id ? board : b)));
    this.updateGuestBoard(board);
  }


  async deleteBoard(id: string) {
    const board = this.boardList().find((b) => b.id === id);
    if (!board) return;
    if (!await this.confirm.open({ title: `Delete "${board.name}"?`, message: "This will permanently delete the board and all its cards." })) return;
    await this.api.delete(`/boards/${id}`);
    this.removeGuestBoard(id);
  }

  async dropBoard(event: CdkDragDrop<Board[]>) {
    if (event.previousIndex === event.currentIndex) return;
    const items = this.boardList();
    const moved = items[event.previousIndex];
    if (!moved) return;
    const reordered = [...items];
    reordered.splice(event.previousIndex, 1);
    reordered.splice(event.currentIndex, 0, moved);
    this.boardList.set(reordered);

    const body =
      event.currentIndex === 0
        ? { beforeBoardId: reordered[1]?.id ?? null }
        : { afterBoardId: reordered[event.currentIndex - 1]?.id };
    const result = await this.api.post<{ id: string; position: string }>(`/boards/${moved.id}/move`, body);
    this.boardList.update((bs) => sortBoards(bs.map((b) => (b.id === result.id ? { ...b, position: result.position } : b))));
    this.guestBoards.update((boards) => sortBoards(boards.map((board) => board.id === result.id ? { ...board, position: result.position } : board)));
  }

  async createApiKey(e: Event) {
    e.preventDefault();
    const name = this.newApiKeyName().trim();
    if (!name) return;
    this.apiKeyError.set(null);
    try {
      const created = await this.api.post<WorkspaceApiKeyRow & { secret: string }>(`/workspaces/${this.workspaceId()}/api-keys`, {
        name,
        scope: this.newApiKeyScope(),
      });
      this.apiKeys.update((keys) => [created, ...keys]);
      this.revealedApiKeySecret.set(created.secret);
      this.newApiKeyName.set("");
      this.newApiKeyScope.set("write");
    } catch (error) {
      this.apiKeyError.set(extractErrorMessage(error));
    }
  }

  async deleteApiKey(id: string) {
    const key = this.apiKeys().find((item) => item.id === id);
    if (!key) return;
    if (!await this.confirm.open({ title: `Delete "${key.name}"?`, message: "Systems using this key will lose access immediately." })) return;
    this.apiKeyError.set(null);
    try {
      await this.api.delete(`/workspaces/${this.workspaceId()}/api-keys/${id}`);
      this.apiKeys.update((keys) => keys.filter((item) => item.id !== id));
    } catch (error) {
      this.apiKeyError.set(extractErrorMessage(error));
    }
  }

  async copyText(value: string | null) {
    if (!value || typeof navigator === "undefined") return;
    await navigator.clipboard?.writeText(value);
  }

  updateWebhookUrl(value: string) {
    this.newWebhookUrl.set(value);
    const url = value.trim();
    if (!url) {
      this.webhookError.set(null);
      return;
    }
    try {
      new URL(url);
      this.webhookError.set(null);
    } catch {
      this.webhookError.set("Please enter a valid webhook URL.");
    }
  }

  private parseWebhookEventTypes(value: string): string[] {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  webhookDeliveriesFor(endpointId: string): WebhookDeliveryRow[] {
    return this.webhookDeliveries()[endpointId] || [];
  }

  async createWebhook(e: Event) {
    e.preventDefault();
    const name = this.newWebhookName().trim();
    const url = this.newWebhookUrl().trim();
    if (!name || !url) return;
    try {
      new URL(url);
    } catch {
      this.webhookError.set("Please enter a valid webhook URL.");
      return;
    }
    this.webhookError.set(null);
    try {
      const created = await this.api.post<WebhookEndpointRow & { secret: string }>(`/workspaces/${this.workspaceId()}/webhooks`, {
        name,
        url,
        eventTypes: this.parseWebhookEventTypes(this.newWebhookEventTypes()),
        enabled: true,
      });
      this.webhooks.update((hooks) => [created, ...hooks]);
      this.revealedWebhookSecret.set(created.secret);
      this.newWebhookName.set("");
      this.newWebhookUrl.set("");
      this.newWebhookEventTypes.set("");
    } catch (error) {
      this.webhookError.set(extractErrorMessage(error));
    }
  }

  async toggleWebhook(endpoint: WebhookEndpointRow) {
    this.webhookError.set(null);
    try {
      const updated = await this.api.patch<WebhookEndpointRow>(`/workspaces/${this.workspaceId()}/webhooks/${endpoint.id}`, {
        enabled: !endpoint.enabled,
      });
      this.webhooks.update((hooks) => hooks.map((hook) => hook.id === endpoint.id ? updated : hook));
    } catch (error) {
      this.webhookError.set(extractErrorMessage(error));
    }
  }

  async deleteWebhook(id: string) {
    const hook = this.webhooks().find((item) => item.id === id);
    if (!hook) return;
    if (!await this.confirm.open({ title: `Delete webhook "${hook.name}"?`, message: "Queued deliveries for this endpoint will be removed." })) return;
    this.webhookError.set(null);
    try {
      await this.api.delete(`/workspaces/${this.workspaceId()}/webhooks/${id}`);
      this.webhooks.update((hooks) => hooks.filter((item) => item.id !== id));
    } catch (error) {
      this.webhookError.set(extractErrorMessage(error));
    }
  }

  async regenerateWebhookSecret(id: string) {
    this.webhookError.set(null);
    try {
      const updated = await this.api.post<WebhookEndpointRow & { secret: string }>(`/workspaces/${this.workspaceId()}/webhooks/${id}/secret`, {});
      this.webhooks.update((hooks) => hooks.map((hook) => hook.id === id ? updated : hook));
      this.revealedWebhookSecret.set(updated.secret);
    } catch (error) {
      this.webhookError.set(extractErrorMessage(error));
    }
  }

  async loadWebhookDeliveries(endpointId: string) {
    this.webhookError.set(null);
    try {
      const deliveries = await this.api.get<WebhookDeliveryRow[]>(`/workspaces/${this.workspaceId()}/webhooks/${endpointId}/deliveries?limit=25`);
      this.webhookDeliveries.update((current) => ({ ...current, [endpointId]: deliveries }));
    } catch (error) {
      this.webhookError.set(extractErrorMessage(error));
    }
  }

  async retryWebhookDelivery(endpointId: string, deliveryId: string) {
    this.webhookError.set(null);
    try {
      await this.api.post(`/workspaces/${this.workspaceId()}/webhooks/${endpointId}/deliveries/${deliveryId}/retry`, {});
      await this.loadWebhookDeliveries(endpointId);
    } catch (error) {
      this.webhookError.set(extractErrorMessage(error));
    }
  }

}
