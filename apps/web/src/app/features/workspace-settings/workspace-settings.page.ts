import { CARD_DUE_DATE_SLOTS } from "@kanera/shared/due-date-slots";
import type { CdkDragDrop } from "@angular/cdk/drag-drop";
import type { OnDestroy } from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, ViewEncapsulation, computed, effect, inject, input, signal } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ActivatedRoute, NavigationEnd, Router, RouterLink } from "@angular/router";
import { AUTOMATION_ACTION_LIMIT, AUTOMATION_LIMIT } from "@kanera/shared/automation-limits";
import type { ColorToken } from "@kanera/shared/colors";
import type { AutomationActionBody, AutomationTriggerCustomFieldValueDto, AutomationTriggerTypeDto, CustomFieldTypeName, DeletionImpactResponse, DueDateSlot } from "@kanera/shared/dto";
import { API_KEY_NAME_MAX_LENGTH, CARD_LABEL_NAME_MAX_LENGTH, WORKSPACE_ENTITY_NAME_MAX_LENGTH } from "@kanera/shared/dto/name-limits";
import type { ServerToClientEvents, WireAutomation, WireAutomationAction, WireCardLabel, WireChecklistTemplate, WireCustomField, WireCustomFieldOption } from "@kanera/shared/events";
import type { Board, BoardGroup, List, Workspace, WorkspaceMember } from "@kanera/shared/schema";
import { DEFAULT_COMPLETED_CARDS_ACTIVE_DAYS, DEFAULT_INACTIVE_CARDS_DAYS } from "@kanera/shared/workspace-defaults";
import { filter } from "rxjs";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { KANERA_DOCS_URL } from "../../shared/docs-link.component";
import type { CardLabelPresentation } from "../board/card-labels.component";
import { formatRelativeTime } from "../board/table-view/table-columns.util";
import { AuthService } from "../../core/auth/auth.service";
import { SocketService } from "../../core/realtime/socket.service";
import { AppTitleService } from "../../core/title/app-title.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { ConfirmService } from "../../shared/confirm.service";
import { PageHeaderComponent } from "../../shared/page-header.component";
import { UpgradePromptService, type UpgradePromptReason } from "../../shared/upgrade-prompt.service";
import { WorkspaceSettingsApiPage } from "./api/api.page";
import { WorkspaceSettingsAutomationsPage } from "./automations/automations.page";
import {
  automationActionIcon,
  automationActionIconClass,
  automationActionLabelChips,
  automationActionLabelColor,
  automationActionLabelIds,
  automationActionSummary,
  automationActionSummarySegments,
  automationActionTargetLabel,
  automationActionTargetValue,
  automationActionTemplateIds,
  automationActionTypeValue,
  automationActionTypes,
  automationActionUserIds,
  automationCompletionValue,
  automationCustomFieldName,
  automationDueOffsetValue,
  automationDueSlotLabel,
  automationDueSlotValue,
  automationLabelName,
  automationMemberName,
  automationMovePlacementValue,
  automationPopulateTextDateFormatLabel,
  automationPopulateTextSource,
  automationPopulateTextValue,
  automationPopulateValueLabel,
  automationSetCustomField,
  automationSetCustomFieldTypes,
  automationTemplateName,
  automationTriggerLabelId,
  automationTriggerLabelMissing,
  automationTriggerLabelName,
  automationTriggerTargetLabel,
  automationTriggerUserIds,
  isAutomationActionComplete,
  isAutomationLabelAction,
  type AutomationLookups,
  type AutomationSummarySegment,
  type PopulateTextDateFormat,
} from "./automations/automation-presentation.util";
import { WorkspaceSettingsBoardsPage } from "./boards/boards.page";
import { WorkspaceSettingsFieldsPage } from "./fields/fields.page";
import { WorkspaceSettingsGeneralPage } from "./general/general.page";
import { WorkspaceSettingsGuestsPage } from "./guests/guests.page";
import { WorkspaceSettingsImportPage } from "./import/import.page";
import { WorkspaceSettingsIntegrationsPage } from "./integrations/integrations.page";
import { WorkspaceSettingsLabelsPage } from "./labels/labels.page";
import { WorkspaceSettingsListsPage } from "./lists/lists.page";
import { WorkspaceSettingsMembersPage } from "./members/members.page";
import { WorkspaceSettingsTemplatesPage } from "./templates/templates.page";

type MemberRow = WorkspaceMember & { email: string; displayName: string; avatarUrl: string | null; lastOnlineAt?: string | Date | null; orgRole?: "owner" | "admin" | "member" };
type WorkspaceRole = "admin" | "member";
type BoardGuestRole = "editor" | "observer";
type ApiKeyScope = "read" | "write" | "admin";

function apiKeyUsageTime(value: string | Date | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function sortWorkspaceApiKeys(keys: WorkspaceApiKeyRow[]): WorkspaceApiKeyRow[] {
  return [...keys].sort((a, b) =>
    apiKeyUsageTime(b.lastUsedAt) - apiKeyUsageTime(a.lastUsedAt)
    || apiKeyUsageTime(b.createdAt) - apiKeyUsageTime(a.createdAt));
}
type WorkspaceSettingsTab = "general" | "boards" | "lists" | "fields" | "templates" | "automations" | "labels" | "members" | "guests" | "integrations" | "api" | "import";
type WorkspaceGuestBoard = Pick<Board, "id" | "name" | "icon" | "iconColor" | "position">;
type AcceptedGuestRow = {
  boardId: string;
  boardName: string;
  userId: string;
  role: BoardGuestRole;
  assignedItemsOnly?: boolean;
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
  assignedItemsOnly?: boolean;
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
type AgentConnectionRow = {
  clientId: string;
  name: string;
  maxScope: ApiKeyScope;
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
  lastSuccessfulAt: string | Date | null;
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
const workspaceSettingsTabs = ["general", "boards", "lists", "fields", "templates", "automations", "labels", "members", "guests", "integrations", "api", "import"] as const;
const standaloneExcludedTabs = new Set<WorkspaceSettingsTab>(["boards", "members"]);
const proSettingsTabs = new Set<WorkspaceSettingsTab>(["guests", "integrations", "api"]);
const workspaceSettingsTabLabels: Record<WorkspaceSettingsTab, string> = {
  general: "General",
  boards: "Boards",
  lists: "Lists",
  fields: "Custom Fields",
  templates: "Checklists",
  automations: "Automations",
  labels: "Card Labels",
  members: "Members",
  guests: "Guests",
  integrations: "Integrations",
  api: "API",
  import: "Import",
};
/** Tabler names, without the `ti-` prefix. Account settings labels its tabs the same way. */
const workspaceSettingsTabIcons: Record<WorkspaceSettingsTab, string> = {
  general: "settings",
  boards: "layout-kanban",
  lists: "columns-3",
  fields: "forms",
  templates: "checklist",
  automations: "bolt",
  labels: "tags",
  members: "users",
  guests: "user-plus",
  integrations: "message-share",
  api: "plug-connected",
  import: "download",
};
type AutomationActionTypeName = (typeof automationActionTypes)[number];
type AutomationTriggerTypeName = AutomationTriggerTypeDto;
type PopulateCustomFieldAction = Extract<AutomationActionBody, { type: "populate_custom_field" }>;
type PopulateCustomFieldValue = PopulateCustomFieldAction["config"]["value"];
type PopulateTextSource = "text" | "current_date";
type PopulateDateSource = "fixed" | "current";
type AutomationDueDatePreset = "0" | "1" | "2" | "7" | "custom";
const automationTextDateFormats = ["date", "month", "month_long_short_year", "month_long_year", "datetime"] as const satisfies readonly PopulateTextDateFormat[];
const automationDueDatePresets = [
  { value: "0", label: "Today" },
  { value: "1", label: "Tomorrow" },
  { value: "2", label: "In 2 days" },
  { value: "7", label: "In 1 week" },
  { value: "custom", label: "Custom..." },
] as const satisfies readonly { value: AutomationDueDatePreset; label: string }[];
const automationDueDatePresetOffsets = new Set<number>(automationDueDatePresets.filter((option) => option.value !== "custom").map((option) => Number(option.value)));

// ─── Example automations ──────────────────────────────────────────────────────
//
// The catalogue behind the empty state and the toolbar's Examples menu. These mirror the worked
// examples in the automations documentation, because those are the patterns support actually
// recommends — not invented-for-the-UI filler.
//
// Two rules keep an example honest, both learned from getting it wrong:
//
//  1. Semantic ingredients — labels, checklist templates, custom fields — are matched by name or not
//     used at all. There is no "first label" or "first text field" fallback: pairing an arbitrary
//     field with an arbitrary value produced sentences like "fill Branch with the current month",
//     which is worse than offering nothing. Only list *positions* have structural meaning on a
//     board (first = intake, last = the end of the workflow), so those are the one positional
//     fallback allowed.
//  2. The sentence is built from the actions that actually resolved, so what the menu promises and
//     what gets created cannot drift. An optional action that found no matching label simply drops
//     out of both. A recipe with nothing left to do, or an unresolvable trigger, is offered greyed
//     out with `requirement` naming the missing piece.
type AutomationRecipeContext = {
  lists: List[];
  labels: WireCardLabel[];
  templates: WireChecklistTemplate[];
  fields: WireCustomField[];
};
/** Trigger + actions only. Everything else on the create DTO takes its default. */
type AutomationRecipeBody = {
  triggerType: AutomationTriggerTypeName;
  triggerListId?: string;
  triggerLabelId?: string;
  applyOnCreate?: boolean;
  applyOnMove?: boolean;
  actions: AutomationActionBody[];
};
const automationRecipeGroups = ["Intake", "In progress", "Wrap-up"] as const;
type AutomationRecipeGroup = (typeof automationRecipeGroups)[number];
type AutomationRecipe = {
  id: string;
  group: AutomationRecipeGroup;
  icon: string;
  title: string;
  /** Generic wording, shown when this workspace cannot build the example yet. */
  detail: string;
  /** The missing piece, phrased as what to add. Only surfaced when `resolve` returns null. */
  requirement: string;
  resolve: (ctx: AutomationRecipeContext) => { detail: string; body: AutomationRecipeBody } | null;
};
/** The resolved row the templates render. */
export type AutomationRecipeOption = {
  id: string;
  group: AutomationRecipeGroup;
  icon: string;
  title: string;
  detail: string;
  available: boolean;
  requirement: string;
};

/**
 * First item whose name contains one of `hints`. Hint order is preference order, so a workspace with
 * both "Review" and "QA" lists gets the one the recipe is really about.
 */
function matchNamed<T>(items: readonly T[], hints: readonly string[], nameOf: (item: T) => string): T | undefined {
  const named = items.map((item) => ({ item, name: nameOf(item).toLocaleLowerCase() }));
  for (const hint of hints) {
    const found = named.find((entry) => entry.name.includes(hint));
    if (found) return found.item;
  }
  return undefined;
}

const matchRecipeList = (lists: List[], hints: readonly string[]) => matchNamed(lists, hints, (list) => list.name);
const matchRecipeLabel = (labels: WireCardLabel[], hints: readonly string[]) => matchNamed(labels, hints, (label) => label.name);
const matchRecipeTemplate = (templates: WireChecklistTemplate[], hints: readonly string[]) => matchNamed(templates, hints, (template) => template.title);
const matchRecipeField = (fields: WireCustomField[], type: CustomFieldTypeName, hints: readonly string[]) =>
  matchNamed(fields.filter((field) => field.type === type), hints, (field) => field.name);

/** "a", "a and b", "a, b and c" — recipe sentences run to three clauses at most. */
function joinRecipeClauses(clauses: string[]): string {
  if (clauses.length < 2) return clauses[0] ?? "";
  return `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
}

// Vocabulary a workspace is likely to use for each workflow stage. Substrings, so "escalat" covers
// both "Escalated" and "Escalation", and "progress" covers "In Progress" and "Progress".
const REVIEW_LIST_HINTS = ["review", "qa", "approval", "testing", "check"];
const DONE_LIST_HINTS = ["done", "complete", "shipped", "closed", "won", "live", "launched"];
const PROGRESS_LIST_HINTS = ["in progress", "progress", "doing", "build", "development", "working"];
const READY_LIST_HINTS = ["ready", "ship", "release", "deploy", "launch", ...DONE_LIST_HINTS];
const REVIEW_LABEL_HINTS = ["needs review", "review", "qa", "testing"];
const REVIEW_TEMPLATE_HINTS = ["qa", "review", "test", "acceptance"];
const TRIAGE_LABEL_HINTS = ["triage", "support", "incoming", "new", "unsorted"];
const TRIAGE_TEMPLATE_HINTS = ["triage", "intake", "support", "onboard"];
const ACTIVE_LABEL_HINTS = ["active", "in progress", "wip", "working", "started"];
const OVERDUE_LABEL_HINTS = ["overdue", "late", "urgent", "at risk", "risk", "escalat"];
const ESCALATION_LABEL_HINTS = ["escalat", "blocked", "urgent", "critical", "issue"];

const automationRecipeCatalogue: readonly AutomationRecipe[] = [
  {
    id: "triage-new-cards",
    group: "Intake",
    icon: "ti-inbox",
    title: "Triage new cards",
    detail: "When a card is created in your first list, label it for triage and apply your intake checklist.",
    requirement: "Needs a triage or support label, or an intake checklist template.",
    resolve: ({ lists, labels, templates }) => {
      const intake = lists[0];
      if (!intake) return null;
      const label = matchRecipeLabel(labels, TRIAGE_LABEL_HINTS);
      const template = matchRecipeTemplate(templates, TRIAGE_TEMPLATE_HINTS);
      const actions: AutomationActionBody[] = [];
      const clauses: string[] = [];
      if (label) {
        actions.push({ type: "add_labels", config: { labelIds: [label.id] } });
        clauses.push(`add the ${label.name} label`);
      }
      if (template) {
        actions.push({ type: "apply_checklists", config: { templateIds: [template.id] } });
        clauses.push(`apply the ${template.title} checklist`);
      }
      if (!actions.length) return null;
      return {
        detail: `When a card is created in ${intake.name}, ${joinRecipeClauses(clauses)}.`,
        // Created only: a card moved back into intake has already been triaged once, and re-applying
        // the checklist would reset the items someone has ticked.
        body: { triggerType: "card_enters_list", triggerListId: intake.id, applyOnCreate: true, applyOnMove: false, actions },
      };
    },
  },
  {
    id: "due-on-intake",
    group: "Intake",
    icon: "ti-calendar-plus",
    title: "Give new work a deadline",
    detail: "When a card lands in your first list, set its due date to tomorrow.",
    requirement: "Add a list first.",
    resolve: ({ lists }) => {
      const intake = lists[0];
      if (!intake) return null;
      return {
        detail: `When a card lands in ${intake.name}, set its due date to tomorrow.`,
        body: {
          triggerType: "card_enters_list",
          triggerListId: intake.id,
          applyOnCreate: true,
          applyOnMove: true,
          actions: [{ type: "set_due_date", config: { offsetDays: 1, slot: "endOfWorkDay" } }],
        },
      };
    },
  },
  {
    id: "start-review",
    group: "In progress",
    icon: "ti-checkup-list",
    title: "Start review consistently",
    detail: "When a card enters your review list, apply the review checklist and flag it as needing review.",
    requirement: "Needs a review or QA list, plus a matching checklist template or label.",
    resolve: ({ lists, labels, templates }) => {
      const review = matchRecipeList(lists, REVIEW_LIST_HINTS);
      if (!review) return null;
      const template = matchRecipeTemplate(templates, REVIEW_TEMPLATE_HINTS);
      const label = matchRecipeLabel(labels, REVIEW_LABEL_HINTS);
      const actions: AutomationActionBody[] = [];
      const clauses: string[] = [];
      if (template) {
        actions.push({ type: "apply_checklists", config: { templateIds: [template.id] } });
        clauses.push(`apply the ${template.title} checklist`);
      }
      if (label) {
        actions.push({ type: "add_labels", config: { labelIds: [label.id] } });
        clauses.push(`add the ${label.name} label`);
      }
      if (!actions.length) return null;
      return {
        detail: `When a card enters ${review.name}, ${joinRecipeClauses(clauses)}.`,
        body: { triggerType: "card_enters_list", triggerListId: review.id, applyOnCreate: true, applyOnMove: true, actions },
      };
    },
  },
  {
    id: "advance-checklist-work",
    group: "In progress",
    icon: "ti-checkbox",
    title: "Advance checklist-driven work",
    detail: "When every checklist item on a card is ticked, move it on and drop the review label.",
    requirement: "Add a second list to move finished work into.",
    resolve: ({ lists, labels }) => {
      if (lists.length < 2) return null;
      const target = matchRecipeList(lists, READY_LIST_HINTS) ?? lists[lists.length - 1];
      if (!target) return null;
      const label = matchRecipeLabel(labels, REVIEW_LABEL_HINTS);
      const actions: AutomationActionBody[] = [{ type: "move_to_list", config: { listId: target.id, placement: "top" } }];
      const clauses = [`move it to the top of ${target.name}`];
      if (label) {
        actions.push({ type: "remove_labels", config: { labelIds: [label.id] } });
        clauses.push(`remove the ${label.name} label`);
      }
      return {
        detail: `When every checklist item on a card is ticked, ${joinRecipeClauses(clauses)}.`,
        body: { triggerType: "all_checklist_items_complete", actions },
      };
    },
  },
  {
    id: "surface-overdue",
    group: "In progress",
    icon: "ti-alarm",
    title: "Surface overdue work",
    detail: "When a card's due date arrives, float it to the top of its list so nobody has to go looking.",
    requirement: "Add a list first.",
    resolve: ({ lists, labels }) => {
      if (!lists.length) return null;
      const label = matchRecipeLabel(labels, OVERDUE_LABEL_HINTS);
      const actions: AutomationActionBody[] = [{ type: "move_to_top", config: {} }];
      const clauses = ["move it to the top of its list"];
      if (label) {
        actions.push({ type: "add_labels", config: { labelIds: [label.id] } });
        clauses.push(`add the ${label.name} label`);
      }
      return {
        detail: `When a card's due date arrives, ${joinRecipeClauses(clauses)}.`,
        body: { triggerType: "due_date_arrives", actions },
      };
    },
  },
  {
    id: "escalate-consistently",
    group: "In progress",
    icon: "ti-flag",
    title: "Escalate consistently",
    detail: "When an escalation label is added, pull the card to the top of its list and stamp when it happened.",
    requirement: "Needs a label like Escalated, Blocked or Urgent.",
    resolve: ({ labels, fields }) => {
      const label = matchRecipeLabel(labels, ESCALATION_LABEL_HINTS);
      if (!label) return null;
      // A date field named for the escalation itself ("Blocked Since", "Escalation Date"); a generic
      // date field would be stamped with a date that means nothing.
      const sinceField = matchRecipeField(fields, "date", ["escalat", "blocked since", "flagged", "raised"]);
      const actions: AutomationActionBody[] = [{ type: "move_to_top", config: {} }];
      const clauses = ["move the card to the top of its list"];
      if (sinceField) {
        actions.push({ type: "populate_custom_field", config: { fieldId: sinceField.id, onlyIfEmpty: true, value: { kind: "date", source: "current" } } });
        clauses.push(`set ${sinceField.name} to today`);
      }
      return {
        detail: `When the ${label.name} label is added, ${joinRecipeClauses(clauses)}.`,
        body: { triggerType: "card_label_set", triggerLabelId: label.id, actions },
      };
    },
  },
  {
    id: "finish-cleanly",
    group: "Wrap-up",
    icon: "ti-circle-check",
    title: "Finish work cleanly",
    detail: "When a card reaches your done list, mark it complete and clear the deadline it no longer needs.",
    requirement: "Add a second list to act as the done list.",
    resolve: ({ lists, labels }) => {
      if (lists.length < 2) return null;
      const done = matchRecipeList(lists, DONE_LIST_HINTS) ?? lists[lists.length - 1];
      if (!done) return null;
      const label = matchRecipeLabel(labels, REVIEW_LABEL_HINTS);
      const actions: AutomationActionBody[] = [
        { type: "set_completion", config: { completed: true } },
        { type: "clear_due_date", config: {} },
      ];
      const clauses = ["mark it complete", "clear its due date"];
      if (label) {
        actions.push({ type: "remove_labels", config: { labelIds: [label.id] } });
        clauses.push(`remove the ${label.name} label`);
      }
      return {
        detail: `When a card enters ${done.name}, ${joinRecipeClauses(clauses)}.`,
        body: { triggerType: "card_enters_list", triggerListId: done.id, applyOnCreate: true, applyOnMove: true, actions },
      };
    },
  },
  {
    id: "reopen-on-return",
    group: "Wrap-up",
    icon: "ti-rotate-2",
    title: "Reopen work that moves back",
    detail: "When a completed card returns to your in-progress list, mark it incomplete again.",
    // No positional fallback: a middle list has no structural meaning, and marking cards incomplete
    // in the wrong one is a destructive guess.
    requirement: "Needs a list named for work in progress.",
    resolve: ({ lists, labels }) => {
      const progress = matchRecipeList(lists, PROGRESS_LIST_HINTS);
      if (!progress) return null;
      const label = matchRecipeLabel(labels, ACTIVE_LABEL_HINTS);
      const actions: AutomationActionBody[] = [{ type: "set_completion", config: { completed: false } }];
      const clauses = ["mark it incomplete"];
      if (label) {
        actions.push({ type: "add_labels", config: { labelIds: [label.id] } });
        clauses.push(`add the ${label.name} label`);
      }
      return {
        detail: `When a card moves back into ${progress.name}, ${joinRecipeClauses(clauses)}.`,
        body: {
          triggerType: "card_enters_list",
          triggerListId: progress.id,
          // Moved only: a card created straight into the in-progress list was never complete.
          applyOnCreate: false,
          applyOnMove: true,
          actions,
        },
      };
    },
  },
  {
    id: "cleanup-completed",
    group: "Wrap-up",
    icon: "ti-eraser",
    title: "Clean up completed work",
    detail: "When a card is marked complete, clear its due date so it stops showing as due.",
    requirement: "Add a list first.",
    resolve: ({ lists, labels }) => {
      if (!lists.length) return null;
      const label = matchRecipeLabel(labels, ACTIVE_LABEL_HINTS);
      const actions: AutomationActionBody[] = [{ type: "clear_due_date", config: {} }];
      const clauses = ["clear its due date"];
      if (label) {
        actions.push({ type: "remove_labels", config: { labelIds: [label.id] } });
        clauses.push(`remove the ${label.name} label`);
      }
      return {
        detail: `When a card is marked complete, ${joinRecipeClauses(clauses)}.`,
        body: { triggerType: "card_marked_complete", actions },
      };
    },
  },
  {
    id: "carry-estimate-into-actuals",
    group: "Wrap-up",
    icon: "ti-arrow-bar-to-right",
    title: "Carry an estimate into actuals",
    detail: "When a card is finished, copy its estimate into the actuals field so the two can be compared.",
    requirement: "Needs two number fields, one for the estimate and one for actuals.",
    resolve: ({ lists, fields }) => {
      const done = matchRecipeList(lists, DONE_LIST_HINTS) ?? (lists.length > 1 ? lists[lists.length - 1] : undefined);
      const estimate = matchRecipeField(fields, "number", ["estimate", "estimated", "planned", "budget"]);
      const actual = matchRecipeField(fields, "number", ["actual", "spent", "logged", "real"]);
      if (!done || !estimate || !actual) return null;
      return {
        detail: `When a card enters ${done.name}, copy ${estimate.name} into ${actual.name} if it is still empty.`,
        body: {
          triggerType: "card_enters_list",
          triggerListId: done.id,
          applyOnCreate: true,
          applyOnMove: true,
          actions: [{ type: "populate_custom_field", config: { fieldId: actual.id, onlyIfEmpty: true, value: { kind: "field", sourceFieldId: estimate.id } } }],
        },
      };
    },
  },
  {
    id: "stamp-completion-month",
    group: "Wrap-up",
    icon: "ti-calendar-stats",
    title: "Stamp the month work finished",
    detail: "When a card is marked complete, record the month in your reporting field.",
    // Only a field that names a month: a text field grabbed by position gets stamped with a value
    // that means nothing to whoever reads the column later.
    requirement: "Needs a text field named for a month or period.",
    resolve: ({ fields }) => {
      const field = matchRecipeField(fields, "text", ["month", "period", "billing"]);
      if (!field) return null;
      return {
        detail: `When a card is marked complete, fill ${field.name} with the current month.`,
        body: {
          triggerType: "card_marked_complete",
          // onlyIfEmpty: a card can be completed, reopened and completed again; the month the work
          // first landed in is the one reporting wants.
          actions: [{ type: "populate_custom_field", config: { fieldId: field.id, onlyIfEmpty: true, value: { kind: "text_current_date", format: "month" } } }],
        },
      };
    },
  },
];

// A save is queued per automation while the admin is still typing into a value field. Without this,
// every keystroke sent a full PUT that deletes and re-inserts every action row, wrote an activity
// entry, and re-broadcast the rule to every workspace admin.
const AUTOMATION_ACTION_SAVE_DEBOUNCE_MS = 500;
const GENERAL_SETTINGS_SAVE_DEBOUNCE_MS = 300;

function automationTimestamp(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

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
  imports: [PageHeaderComponent, RouterLink, WorkspaceSettingsGeneralPage, WorkspaceSettingsBoardsPage, WorkspaceSettingsListsPage, WorkspaceSettingsFieldsPage, WorkspaceSettingsTemplatesPage, WorkspaceSettingsAutomationsPage, WorkspaceSettingsLabelsPage, WorkspaceSettingsMembersPage, WorkspaceSettingsGuestsPage, WorkspaceSettingsIntegrationsPage, WorkspaceSettingsApiPage, WorkspaceSettingsImportPage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  templateUrl: "./workspace-settings.page.html",
  styleUrl: "./workspace-settings.page.scss",
})
export class WorkspaceSettingsPage implements OnDestroy {
  readonly completedCardsActiveDaysDefault = DEFAULT_COMPLETED_CARDS_ACTIVE_DAYS;
  readonly inactiveCardsDaysDefault = DEFAULT_INACTIVE_CARDS_DAYS;

  private readonly api = inject(ApiClient);
  private readonly appTitle = inject(AppTitleService);
  private readonly auth = inject(AuthService);
  private readonly confirm = inject(ConfirmService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sockets = inject(SocketService);
  private readonly upgradePrompt = inject(UpgradePromptService);
  private readonly workspaceService = inject(WorkspaceService);
  private nameSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private generalSettingsSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // The public input must match the route parameter while the resolved id remains writable for the
  // board-facing route. Angular input signals cannot otherwise share that public binding name.
  // eslint-disable-next-line @angular-eslint/no-input-rename
  readonly routeWorkspaceId = input<string | undefined>(undefined, { alias: "workspaceId" });
  readonly boardId = input<string | undefined>();
  // All existing settings tabs consume this resolved id. Standalone routes populate it from the
  // lightweight board endpoint so the workspace-scoped settings implementation stays shared.
  readonly workspaceId = signal("");
  private readonly routeTab = signal<string | undefined>(undefined);
  readonly selectedTab = signal<WorkspaceSettingsTab>("general");
  readonly workspace = signal<Workspace | null>(null);
  readonly boardLinkingEnabledDraft = signal(true);
  readonly boardLinkingSaving = signal(false);
  readonly boardLinkingError = signal<string | null>(null);
  readonly boardHealthEnabledDraft = signal(true);
  readonly boardHealthOverdueEnabledDraft = signal(true);
  readonly boardHealthUnassignedEnabledDraft = signal(true);
  readonly boardHealthInactiveEnabledDraft = signal(true);
  readonly boardHealthSaving = signal(false);
  readonly boardHealthError = signal<string | null>(null);
  readonly completedCardsActiveDaysDraft = signal(DEFAULT_COMPLETED_CARDS_ACTIVE_DAYS);
  readonly inactiveCardsDaysDraft = signal(DEFAULT_INACTIVE_CARDS_DAYS);
  readonly isStandalone = computed(() => this.workspace()?.kind === "board");
  readonly entityLabel = computed(() => this.isStandalone() ? "board" : "workspace");
  readonly entityLabelTitle = computed(() => this.isStandalone() ? "Board" : "Workspace");
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
  // Per-board access management (Boards tab): the board whose shared menu is open.
  readonly managingBoardAccessId = signal<string | null>(null);
  readonly editingListId = signal<string | null>(null);
  readonly editingListName = signal("");
  readonly deletionPreviewKey = signal<string | null>(null);
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
  /**
   * One snapshot of the collections automation summaries resolve ids against.
   *
   * A `computed` rather than a fresh object per call: the summary helpers run once per action per
   * rendered rule, so a workspace with a dozen automations would otherwise rebuild this object
   * dozens of times per change-detection pass. Read-only — nothing writes back through it, so the
   * new object identity on each dependency change cannot feed an effect loop.
   */
  private readonly automationLookups = computed<AutomationLookups>(() => ({
    lists: this.lists(),
    labels: this.labels(),
    members: this.members(),
    templates: this.templates(),
    fields: this.fields(),
  }));

  readonly automationActionTypes = automationActionTypes;
  readonly automationActionLimit = AUTOMATION_ACTION_LIMIT;
  readonly automationLimit = AUTOMATION_LIMIT;
  readonly automationLimitHint = computed(() => `${this.entityLabelTitle()}s can have up to ${AUTOMATION_LIMIT} automations. Contact support if you need more.`);
  readonly automationLimitReached = computed(() => this.automations().length >= AUTOMATION_LIMIT);
  readonly automationTextDateFormats = automationTextDateFormats;
  readonly automationDueDatePresets = automationDueDatePresets;
  readonly automationSetCustomFields = computed(() => this.fields().filter((field) => (automationSetCustomFieldTypes as readonly CustomFieldTypeName[]).includes(field.type)));
  readonly automationTriggerCustomFields = computed(() => this.fields().filter((field) => {
    if (field.type === "select") return field.options.length > 0;
    if (field.type === "user") return this.automationMembers().length > 0;
    return true;
  }));
  readonly enabledAutomationCount = computed(() => this.automations().filter((automation) => automation.enabled).length);
  readonly automationRecipeGroups = automationRecipeGroups;
  /**
   * Example automations, resolved against this workspace's lists, labels, templates and fields.
   *
   * Available ones sort to the top of their group so a workspace that has not set up labels yet
   * still leads with the examples it can actually use, rather than three dimmed rows.
   */
  readonly automationRecipes = computed<AutomationRecipeOption[]>(() => {
    const ctx: AutomationRecipeContext = { lists: this.lists(), labels: this.labels(), templates: this.templates(), fields: this.fields() };
    const options = automationRecipeCatalogue.map((recipe) => {
      const resolved = recipe.resolve(ctx);
      return {
        id: recipe.id,
        group: recipe.group,
        icon: recipe.icon,
        title: recipe.title,
        detail: resolved?.detail ?? recipe.detail,
        available: resolved !== null,
        requirement: recipe.requirement,
      } satisfies AutomationRecipeOption;
    });
    return automationRecipeGroups.flatMap((group) => {
      const inGroup = options.filter((option) => option.group === group);
      return [...inGroup.filter((option) => option.available), ...inGroup.filter((option) => !option.available)];
    });
  });
  readonly availableAutomationRecipeCount = computed(() => this.automationRecipes().filter((recipe) => recipe.available).length);
  readonly creatingAutomation = signal(false);
  private readonly pendingAutomationSaves = new Map<string, number>();
  readonly automationMembers = computed(() =>
    [...this.members()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }) ||
      a.email.localeCompare(b.email, undefined, { sensitivity: "base" }),
    ),
  );
  readonly dueDateSlots: readonly DueDateSlot[] = CARD_DUE_DATE_SLOTS;
  readonly editingLabelId = signal<string | null>(null);
  readonly editingLabelName = signal("");
  readonly addMemberUserId = signal("");
  readonly addMemberRole = signal<WorkspaceRole>("member");
  readonly memberSearch = signal("");
  readonly guestBoards = signal<WorkspaceGuestBoard[]>([]);
  readonly acceptedGuests = signal<AcceptedGuestRow[]>([]);
  readonly pendingGuestInvites = signal<PendingGuestInviteRow[]>([]);
  readonly guestBoardId = signal("");
  readonly guestEmail = signal("");
  readonly guestRole = signal<BoardGuestRole>("editor");
  readonly guestAssignedItemsOnly = signal(false);
  readonly guestError = signal<string | null>(null);
  readonly guestBusy = signal(false);
  readonly guestRemovingId = signal<string | null>(null);
  readonly guestAccessUpdatingId = signal<string | null>(null);
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
    return this.orgUsers()
      .filter((u) => !memberIds.has(u.id))
      .sort((a, b) =>
        a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }) ||
        a.email.localeCompare(b.email, undefined, { sensitivity: "base" }),
      );
  });
  readonly filteredMembers = computed(() => {
    const q = this.memberSearch().trim().toLowerCase();
    const matches = q ? this.members().filter(
      (m) => m.displayName.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
    ) : this.members();
    return [...matches].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }) ||
      a.email.localeCompare(b.email, undefined, { sensitivity: "base" }),
    );
  });
  readonly sortedAcceptedGuests = computed(() => [...this.acceptedGuests()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }) ||
    a.email.localeCompare(b.email, undefined, { sensitivity: "base" }) ||
    a.boardName.localeCompare(b.boardName, undefined, { sensitivity: "base" }),
  ));
  readonly sortedPendingGuestInvites = computed(() => [...this.pendingGuestInvites()].sort((a, b) =>
    a.email.localeCompare(b.email, undefined, { sensitivity: "base" }) ||
    a.boardName.localeCompare(b.boardName, undefined, { sensitivity: "base" }),
  ));
  readonly currentUserId = computed(() => this.auth.user()?.id ?? "");
  readonly ownerClientId = computed(() => this.auth.user()?.clientId ?? null);
  readonly currentMember = computed(() => this.members().find((m) => m.userId === this.currentUserId()) ?? null);
  readonly workspaceRole = computed(() => (this.workspace() as (Workspace & { role?: WorkspaceRole }) | null)?.role ?? null);
  readonly canManageApi = computed(() => {
    const role = this.currentMember()?.role ?? this.workspaceRole();
    return role === "admin" || this.auth.isOrgAdmin();
  });
  readonly canManageGuests = this.canManageApi;
  readonly isHosted = computed(() => this.auth.user()?.deploymentMode === "hosted");
  readonly settingsTabs = computed(() => workspaceSettingsTabs
    .filter((tab) => !(this.isStandalone() && standaloneExcludedTabs.has(tab)))
    .filter((tab) => (tab !== "api" && tab !== "integrations") || this.canManageApi())
    .filter((tab) => tab !== "guests" || this.canManageGuests())
    .map((id) => ({ id, label: workspaceSettingsTabLabels[id], icon: workspaceSettingsTabIcons[id], pro: this.isHosted() && proSettingsTabs.has(id) })));
  // Managing per-board access is a workspace-admin (or org-admin) action; the API additionally
  // enforces board-admin on every mutation.
  readonly canManageBoardAccess = this.canManageApi;

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
  readonly enabledAutomationAllowance = this.auth.maxEnabledAutomations;
  readonly automationExecutionLimitHint = computed(() => {
    const max = this.auth.maxAutomationExecutionsPerMonth();
    return max === null ? null : `Your plan includes ${max} automation executions per month.`;
  });
  readonly automationExecutionAllowance = this.auth.maxAutomationExecutionsPerMonth;
  readonly automationExecutionsRemaining = signal<number | null>(null);
  readonly automationExecutionAllowanceExhausted = computed(() => this.automationExecutionsRemaining() === 0);
  readonly planUpgradeHint = "Upgrade your plan to unlock this.";
  readonly workspaceEntityNameMaxLength = WORKSPACE_ENTITY_NAME_MAX_LENGTH;
  readonly labelNameMaxLength = CARD_LABEL_NAME_MAX_LENGTH;
  readonly apiKeyNameMaxLength = API_KEY_NAME_MAX_LENGTH;

  readonly apiDocsUrl = `${KANERA_DOCS_URL}/api`;
  readonly customFieldError = signal<string | null>(null);
  readonly apiKeys = signal<WorkspaceApiKeyRow[]>([]);
  readonly agentConnections = signal<AgentConnectionRow[]>([]);
  readonly webhooks = signal<WebhookEndpointRow[]>([]);
  readonly webhookDeliveries = signal<Record<string, WebhookDeliveryRow[]>>({});
  readonly newApiKeyName = signal("");
  readonly newApiKeyScope = signal<ApiKeyScope>("write");
  readonly editingApiKeyId = signal<string | null>(null);
  readonly editingApiKeyName = signal("");
  readonly apiKeyError = signal<string | null>(null);
  readonly revealedApiKeySecret = signal<string | null>(null);
  readonly newAgentConnectionName = signal("");
  readonly newAgentConnectionScope = signal<ApiKeyScope>("write");
  readonly agentConnectionError = signal<string | null>(null);
  readonly revealedAgentCredential = signal<{ clientId: string; clientSecret: string; tokenEndpoint: string } | null>(null);
  readonly newWebhookName = signal("");
  readonly newWebhookUrl = signal("");
  readonly newWebhookEventTypes = signal("");
  readonly webhookError = signal<string | null>(null);
  readonly revealedWebhookSecret = signal<string | null>(null);
  readonly customFieldValidation = computed(() => {
    const name = this.newField().trim();
    if (!name) return this.customFieldError();
    if (this.hasDuplicateFieldName(name)) return `Custom field names must be unique within this ${this.entityLabel()}.`;
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

      if ((this.isStandalone() && standaloneExcludedTabs.has(tab)) ||
        ((tab === "api" || tab === "integrations") && this.workspace() && !this.canManageApi()) ||
        (tab === "guests" && this.workspace() && !this.canManageGuests())) {
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
        // --accent-soft resolves its var(--accent) where it is *declared*, so the :root
        // definition would stay the default teal here. Rebind it with the accent itself.
        style.setProperty("--accent-soft", `color-mix(in srgb, var(--color-${color}) 8%, transparent)`);
      } else {
        style.removeProperty("--accent");
        style.removeProperty("--accent-hover");
        style.removeProperty("--ring");
        style.removeProperty("--accent-soft");
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
      if (this.isStandalone() && standaloneExcludedTabs.has(this.selectedTab())) {
        this.selectTab("general", true);
      }
    });

    effect((onCleanup) => {
      const routeWorkspaceId = this.routeWorkspaceId();
      const boardId = this.boardId();
      let cancelled = false;
      let detach: () => void = () => undefined;
      this.reset();
      this.workspaceId.set("");

      void (async () => {
        const workspaceId = boardId
          ? (await this.api.get<Pick<Board, "workspaceId">>(`/boards/${boardId}`)).workspaceId
          : routeWorkspaceId;
        if (!workspaceId || cancelled) return;
        this.workspaceId.set(workspaceId);
        detach = this.attachSocket(workspaceId);
        await this.reload(workspaceId);
      })();

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
    this.saveGeneralSettingsNow();
    // A debounced action save must not be lost because the admin navigated away mid-edit.
    this.flushAllAutomationActionSaves();
    this.workspaceService.setActiveAccentColor(null);
  }

  selectTab(tab: WorkspaceSettingsTab, replaceUrl = false) {
    if ((this.isStandalone() && standaloneExcludedTabs.has(tab)) ||
      ((tab === "api" || tab === "integrations") && !this.canManageApi()) || (tab === "guests" && !this.canManageGuests())) {
      tab = "general";
    }
    this.selectedTab.set(tab);
    void this.router.navigate([tab], {
      relativeTo: this.route,
      replaceUrl,
    });
  }

  private reset() {
    this.saveGeneralSettingsNow();
    this.clearNameSaveTimer();
    // Flush before wiping the drafts: reset runs on workspace switch, and a queued save still
    // refers to the outgoing workspace's rules, which are about to be dropped from state.
    this.flushAllAutomationActionSaves();
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
    this.addMemberRole.set("member");
    this.memberSearch.set("");
    this.guestBoards.set([]);
    this.acceptedGuests.set([]);
    this.pendingGuestInvites.set([]);
    this.guestBoardId.set("");
    this.guestEmail.set("");
    this.guestRole.set("editor");
    this.guestAssignedItemsOnly.set(false);
    this.guestError.set(null);
    this.guestBusy.set(false);
    this.guestRemovingId.set(null);
    this.guestAccessUpdatingId.set(null);
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
    this.managingBoardAccessId.set(null);
    this.apiKeys.set([]);
    this.agentConnections.set([]);
    this.webhooks.set([]);
    this.webhookDeliveries.set({});
    this.newApiKeyName.set("");
    this.newApiKeyScope.set("write");
    this.editingApiKeyId.set(null);
    this.editingApiKeyName.set("");
    this.apiKeyError.set(null);
    this.revealedApiKeySecret.set(null);
    this.newAgentConnectionName.set("");
    this.newAgentConnectionScope.set("write");
    this.agentConnectionError.set(null);
    this.revealedAgentCredential.set(null);
    this.newWebhookName.set("");
    this.newWebhookUrl.set("");
    this.newWebhookEventTypes.set("");
    this.webhookError.set(null);
    this.revealedWebhookSecret.set(null);
  }

  async reload(workspaceId = this.workspaceId()) {
    const detail = await this.api.get<{ workspace: Workspace; role: WorkspaceRole; lists: List[]; customFields: WireCustomField[]; cardLabels: WireCardLabel[]; checklistTemplates: WireChecklistTemplate[]; automations: WireAutomation[]; automationExecutionsRemaining: number | null }>(`/workspaces/${workspaceId}`);
    const ws = { ...detail.workspace, role: detail.role } as Workspace & { role: WorkspaceRole };
    const canManageApi = detail.role === "admin" || this.auth.isOrgAdmin();
    const [members, orgUsers, boards, boardGroups] = await Promise.all([
      this.api.get<MemberRow[]>(`/workspaces/${workspaceId}/members`),
      this.api.get<{ id: string; email: string; displayName: string }[]>(`/workspaces/${workspaceId}/member-candidates`),
      this.api.get<Board[]>(`/workspaces/${workspaceId}/boards`),
      this.api.get<BoardGroup[]>(`/workspaces/${workspaceId}/board-groups`),
    ]);
    const [apiKeys, agentConnections, webhooks, guests] = canManageApi
      ? await Promise.all([
        this.api.get<WorkspaceApiKeyRow[]>(`/workspaces/${workspaceId}/api-keys`),
        this.api.get<AgentConnectionRow[]>(`/workspaces/${workspaceId}/agent-connections`),
        this.api.get<WebhookEndpointRow[]>(`/workspaces/${workspaceId}/webhooks`),
        this.api.get<WorkspaceGuestsResponse>(`/workspaces/${workspaceId}/guests`),
      ])
      : [[] as WorkspaceApiKeyRow[], [] as AgentConnectionRow[], [] as WebhookEndpointRow[], null];
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
    this.automationExecutionsRemaining.set(typeof detail.automationExecutionsRemaining === "number" ? detail.automationExecutionsRemaining : null);
    this.guestBoards.set(sortBoards(guests?.boards ?? boards));
    this.acceptedGuests.set(guests?.acceptedGuests ?? []);
    this.pendingGuestInvites.set(guests?.pendingInvites ?? []);
    this.apiKeys.set(apiKeys);
    this.agentConnections.set(Array.isArray(agentConnections) ? agentConnections : []);
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
        if (member.userId === this.currentUserId()) void this.reconcileCurrentSettingsAccess();
      },
      "client:user:role-changed": ({ userId }) => {
        if (userId === this.currentUserId()) void this.reconcileCurrentSettingsAccess();
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
        if (board.archivedAt) return;
        this.boardList.update((bs) => bs.some((b) => b.id === board.id) ? bs : sortBoards([...bs, board as unknown as Board]));
        this.upsertGuestBoard(board as unknown as Board);
      },
      "board:updated": ({ board }) => {
        const updated = board as unknown as Board;
        if (updated.archivedAt) {
          this.boardList.update((bs) => bs.filter((b) => b.id !== updated.id));
          this.removeGuestBoard(updated.id);
          if (this.managingBoardAccessId() === updated.id) this.managingBoardAccessId.set(null);
          return;
        }
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
        if (this.managingBoardAccessId() === boardId) this.managingBoardAccessId.set(null);
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
    this.boardLinkingEnabledDraft.set(ws?.boardLinkingEnabled !== false);
    // Keep locally queued values visible if an unrelated workspace mutation or realtime echo lands
    // during the debounce window. The defaults save response synchronizes them after the timer clears.
    if (!this.generalSettingsSaveTimer) {
      this.boardHealthEnabledDraft.set(ws?.boardHealthEnabled !== false);
      this.boardHealthOverdueEnabledDraft.set(ws?.boardHealthOverdueEnabled !== false);
      this.boardHealthUnassignedEnabledDraft.set(ws?.boardHealthUnassignedEnabled !== false);
      this.boardHealthInactiveEnabledDraft.set(ws?.boardHealthInactiveEnabled !== false);
      this.completedCardsActiveDaysDraft.set(ws?.completedCardsActiveDays ?? this.completedCardsActiveDaysDefault);
      this.inactiveCardsDaysDraft.set(ws?.inactiveCardsDays ?? this.inactiveCardsDaysDefault);
    }
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

  private async patchWorkspace(patch: { name?: string; cardKeyPrefix?: string; icon?: string | null; accentColor?: ColorToken | null; completedCardsActiveDays?: number; inactiveCardsDays?: number; boardHealthEnabled?: boolean; boardHealthOverdueEnabled?: boolean; boardHealthUnassignedEnabled?: boolean; boardHealthInactiveEnabled?: boolean; boardLinkingEnabled?: boolean }) {
    const ws = await this.api.patch<Workspace>(`/workspaces/${this.workspaceId()}`, patch);
    this.applyWorkspace(ws);
  }

  private async patchEntityName(name: string) {
    const standaloneBoardId = this.isStandalone() ? this.boardId() : undefined;
    if (!standaloneBoardId) {
      await this.patchWorkspace({ name });
      return;
    }

    // A standalone board's visible identity is the board row. Use the same mutation as the Boards
    // settings rename so board clients receive the canonical event first; the API mirrors and emits
    // the hidden workspace row for settings and navigation consumers.
    const board = await this.api.patch<Board>(`/boards/${standaloneBoardId}`, { name });
    this.boardList.update((boards) => boards.map((item) => item.id === board.id ? board : item));
    this.updateGuestBoard(board);
    this.workspace.update((workspace) => workspace ? { ...workspace, name: board.name, updatedAt: board.updatedAt } : workspace);
  }

  updateWorkspaceName(value: string) {
    this.name.set(value);
    this.clearNameSaveTimer();
    const name = value.trim();
    if (!name || name === this.workspace()?.name) return;
    this.nameSaveTimer = setTimeout(() => {
      this.nameSaveTimer = null;
      void this.patchEntityName(name);
    }, 300);
  }

  saveWorkspaceNameNow() {
    this.clearNameSaveTimer();
    const name = this.name().trim();
    if (!name || name === this.workspace()?.name) return;
    void this.patchEntityName(name);
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
    this.completedCardsActiveDaysDraft.set(days);
    this.queueGeneralSettingsSave();
  }

  updateInactiveCardsDays(value: string) {
    const days = Math.max(0, Math.min(365, Math.trunc(Number(value) || 0)));
    this.inactiveCardsDaysDraft.set(days);
    this.queueGeneralSettingsSave();
  }

  updateBoardHealthEnabled(enabled: boolean) {
    if (!this.workspace() || this.boardHealthSaving()) return;
    this.boardHealthEnabledDraft.set(enabled);
    this.queueGeneralSettingsSave();
  }

  updateBoardHealthSignal(signal: "overdue" | "unassigned" | "inactive", enabled: boolean) {
    if (!this.workspace() || !this.boardHealthEnabledDraft() || this.boardHealthSaving()) return;
    if (signal === "overdue") this.boardHealthOverdueEnabledDraft.set(enabled);
    else if (signal === "unassigned") this.boardHealthUnassignedEnabledDraft.set(enabled);
    else this.boardHealthInactiveEnabledDraft.set(enabled);
    this.queueGeneralSettingsSave();
  }

  private queueGeneralSettingsSave() {
    if (this.generalSettingsSaveTimer) clearTimeout(this.generalSettingsSaveTimer);
    this.generalSettingsSaveTimer = setTimeout(() => {
      this.generalSettingsSaveTimer = null;
      void this.saveGeneralSettings();
    }, GENERAL_SETTINGS_SAVE_DEBOUNCE_MS);
  }

  saveGeneralSettingsNow() {
    if (!this.generalSettingsSaveTimer) return;
    clearTimeout(this.generalSettingsSaveTimer);
    this.generalSettingsSaveTimer = null;
    void this.saveGeneralSettings();
  }

  private async saveGeneralSettings() {
    const workspace = this.workspace();
    const workspaceId = this.workspaceId();
    if (!workspace || !workspaceId || this.boardHealthSaving()) return;
    const patch = {
      completedCardsActiveDays: this.completedCardsActiveDaysDraft(),
      inactiveCardsDays: this.inactiveCardsDaysDraft(),
      boardHealthEnabled: this.boardHealthEnabledDraft(),
      boardHealthOverdueEnabled: this.boardHealthOverdueEnabledDraft(),
      boardHealthUnassignedEnabled: this.boardHealthUnassignedEnabledDraft(),
      boardHealthInactiveEnabled: this.boardHealthInactiveEnabledDraft(),
    };
    if (workspace.completedCardsActiveDays === patch.completedCardsActiveDays &&
      workspace.inactiveCardsDays === patch.inactiveCardsDays &&
      (workspace.boardHealthEnabled !== false) === patch.boardHealthEnabled &&
      (workspace.boardHealthOverdueEnabled !== false) === patch.boardHealthOverdueEnabled &&
      (workspace.boardHealthUnassignedEnabled !== false) === patch.boardHealthUnassignedEnabled &&
      (workspace.boardHealthInactiveEnabled !== false) === patch.boardHealthInactiveEnabled) return;

    this.boardHealthSaving.set(true);
    this.boardHealthError.set(null);
    try {
      const updated = await this.api.patch<Workspace>(`/workspaces/${workspaceId}`, patch);
      if (this.workspaceId() === workspaceId) this.applyWorkspace(updated);
    } catch {
      if (this.workspaceId() === workspaceId) {
        this.boardHealthEnabledDraft.set(workspace.boardHealthEnabled !== false);
        this.boardHealthOverdueEnabledDraft.set(workspace.boardHealthOverdueEnabled !== false);
        this.boardHealthUnassignedEnabledDraft.set(workspace.boardHealthUnassignedEnabled !== false);
        this.boardHealthInactiveEnabledDraft.set(workspace.boardHealthInactiveEnabled !== false);
        this.completedCardsActiveDaysDraft.set(workspace.completedCardsActiveDays);
        this.inactiveCardsDaysDraft.set(workspace.inactiveCardsDays);
        this.boardHealthError.set(`${this.entityLabelTitle()} defaults could not be updated.`);
      }
    } finally {
      this.boardHealthSaving.set(false);
    }
  }

  async updateCardKeyPrefix(cardKeyPrefix: string) {
    await this.patchWorkspace({ cardKeyPrefix });
  }

  async updateBoardLinkingEnabled(enabled: boolean, control?: HTMLInputElement) {
    const workspace = this.workspace();
    if (!workspace || this.boardLinkingSaving()) return;
    const previous = workspace.boardLinkingEnabled !== false;
    const restorePrevious = () => {
      this.boardLinkingEnabledDraft.set(previous);
      // The browser owns the immediate checkbox toggle. A fast async cancellation can be batched
      // before Angular renders the draft transition, so restore the native property as well.
      if (control) control.checked = previous;
    };
    if (previous === enabled) {
      restorePrevious();
      return;
    }
    // Native checkboxes update themselves before the change handler runs. Mirror that state in a
    // signal so cancellation can produce a real false → true transition and restore the DOM.
    this.boardLinkingEnabledDraft.set(enabled);
    this.boardLinkingSaving.set(true);
    this.boardLinkingError.set(null);
    try {
      if (!enabled) {
        const { count } = await this.api.get<{ count: number }>(`/workspaces/${this.workspaceId()}/mirror-status`);
        if (count > 0 && !await this.confirm.open({
          title: "Disable board linking?",
          message: `${count} board link${count === 1 ? "" : "s"} will be deleted. This cannot be undone.`,
          confirmLabel: "Disable and delete links",
          danger: true,
        })) {
          restorePrevious();
          return;
        }
      }
      await this.patchWorkspace({ boardLinkingEnabled: enabled });
    } catch {
      restorePrevious();
      this.boardLinkingError.set("Board linking could not be updated.");
    } finally {
      this.boardLinkingSaving.set(false);
    }
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
    if (!list || this.deletionPreviewKey()) return;
    this.deletionPreviewKey.set(`list:${id}`);
    try {
      const confirmed = await this.confirm.openAfterLoading({
        title: `Delete list "${list.name}"?`,
        loadingMessage: "Checking how many cards will be deleted...",
      }, async () => {
        const { cardCount } = await this.api.get<DeletionImpactResponse>(`/lists/${id}/deletion-impact`);
        const cardLabel = cardCount === 1 ? "card" : "cards";
        return `${cardCount} ${cardLabel} will also be permanently deleted. Are you sure?`;
      });
      if (!confirmed) return;
      await this.api.delete(`/lists/${id}`);
      this.lists.update((items) => items.filter((l) => l.id !== id));
    } finally {
      this.deletionPreviewKey.set(null);
    }
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
    return automation.triggerType === "card_leaves_list" || automation.triggerType === "due_date_arrives" || automation.triggerType === "due_date_approaching" || automation.triggerType === "card_becomes_inactive" || automation.triggerType === "all_checklist_items_complete" || automation.triggerType === "card_assigned_to_user" || automation.triggerType === "card_marked_complete" || automation.triggerType === "card_label_set" || automation.triggerType === "custom_field_value_changed" ? automation.triggerType : "card_enters_list";
  }

  automationTriggerListValue(automation: WireAutomation): string {
    return automation.triggerListId ?? "";
  }

  automationTriggerUserIds(automation: WireAutomation): string[] { return automationTriggerUserIds(automation); }

  automationTriggerLabelId(automation: WireAutomation): string { return automationTriggerLabelId(automation); }

  automationTriggerLabelMissing(automation: WireAutomation): boolean { return automationTriggerLabelMissing(automation, this.automationLookups()); }

  automationTriggerDaysBefore(automation: WireAutomation): number { return automation.triggerDaysBefore ?? 3; }

  automationTriggerCustomField(automation: WireAutomation): WireCustomField | null {
    return this.fields().find((field) => field.id === automation.triggerCustomFieldId) ?? null;
  }

  automationTriggerCustomFieldValue(automation: WireAutomation): AutomationTriggerCustomFieldValueDto | null {
    return automation.triggerCustomFieldValue ?? null;
  }

  automationTriggerCustomFieldMissing(automation: WireAutomation): boolean {
    return Boolean(automation.triggerCustomFieldId) && !this.automationTriggerCustomField(automation);
  }

  automationTriggerCustomOptionMissing(automation: WireAutomation): boolean {
    const field = this.automationTriggerCustomField(automation);
    const value = automation.triggerCustomFieldValue;
    return Boolean(field?.type === "select" && value?.kind === "select" && !field.options.some((option) => option.id === value.optionId));
  }

  automationActionTypeValue(action: AutomationActionBody): string { return automationActionTypeValue(action); }

  automationActionTargetValue(action: AutomationActionBody): string { return automationActionTargetValue(action); }

  automationActionUserIds(action: AutomationActionBody): string[] { return automationActionUserIds(action); }

  automationActionLabelIds(action: AutomationActionBody): string[] { return automationActionLabelIds(action); }

  automationActionLabelChips(action: AutomationActionBody): CardLabelPresentation[] { return automationActionLabelChips(action, this.automationLookups()); }

  automationActionTemplateIds(action: AutomationActionBody): string[] { return automationActionTemplateIds(action); }

  automationMovePlacementValue(action: AutomationActionBody): "top" | "bottom" { return automationMovePlacementValue(action); }

  automationDueOffsetValue(action: AutomationActionBody): number { return automationDueOffsetValue(action); }

  automationDueDatePresetValue(action: AutomationActionBody, automationId?: string, index?: number): AutomationDueDatePreset {
    if (automationId !== undefined && index !== undefined && this.customAutomationDueDateDrafts().has(this.automationActionDraftKey(automationId, index))) return "custom";
    const offsetDays = this.automationDueOffsetValue(action);
    return automationDueDatePresetOffsets.has(offsetDays) ? `${offsetDays}` as AutomationDueDatePreset : "custom";
  }

  isAutomationDueDateCustom(action: AutomationActionBody, automationId?: string, index?: number): boolean {
    return this.automationDueDatePresetValue(action, automationId, index) === "custom";
  }

  automationDueSlotValue(action: AutomationActionBody): DueDateSlot { return automationDueSlotValue(action); }

  automationDueSlotLabel(slot: DueDateSlot): string { return automationDueSlotLabel(slot); }

  automationCompletionValue(action: AutomationActionBody): string { return automationCompletionValue(action); }

  automationSetCustomField(action: AutomationActionBody): WireCustomField | null { return automationSetCustomField(action, this.automationLookups()); }

  automationPopulateTextSource(action: AutomationActionBody): PopulateTextSource { return automationPopulateTextSource(action); }

  automationPopulateTextValue(action: AutomationActionBody): string { return automationPopulateTextValue(action); }

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

  // "value" = set a literal/computed value; "field" = copy from another field of the same type.
  automationPopulateMode(action: AutomationActionBody): "value" | "field" {
    return action.type === "populate_custom_field" && action.config.value.kind === "field" ? "field" : "value";
  }

  automationPopulateSourceFieldId(action: AutomationActionBody): string {
    return action.type === "populate_custom_field" && action.config.value.kind === "field" ? action.config.value.sourceFieldId : "";
  }

  // Fields eligible as a copy source: same type as the target, excluding the target itself.
  // Options are field-scoped, so a select source is matched to the target by option label at apply time.
  automationPopulateSourceFields(action: AutomationActionBody): WireCustomField[] {
    const target = this.automationSetCustomField(action);
    if (!target) return [];
    return this.automationSetCustomFields().filter((field) => field.type === target.type && field.id !== target.id);
  }

  automationActionLabel(type: string): string {
    if (type === "move_to_top") return "move to top";
    if (type === "move_to_bottom") return "move to bottom";
    if (type === "apply_checklists") return "apply checklist";
    if (type === "populate_custom_field") return "set custom field";
    return type.replaceAll("_", " ");
  }

  /**
   * The rule's title, and now the only place the trigger is stated — the collapsed summary beneath
   * it lists actions only. Composed from the same event/target pieces the editor uses so the two can
   * never drift, and for `card_enters_list` the event half folds in the create/move scope, which is
   * why the sentence says more than the trigger type alone.
   */
  automationTriggerLabel(automation: WireAutomation): string {
    const event = this.automationTriggerEventLabel(automation);
    const target = this.automationTriggerTargetLabel(automation);
    return target ? `${event} ${target}` : event;
  }

  automationTriggerEventLabel(automation: WireAutomation): string {
    if (automation.triggerType === "card_leaves_list") return "Card leaves";
    if (automation.triggerType === "due_date_arrives") return "Due date arrives";
    if (automation.triggerType === "due_date_approaching") return "Due date approaches";
    if (automation.triggerType === "card_becomes_inactive") return "Card becomes inactive";
    if (automation.triggerType === "all_checklist_items_complete") return "All checklist items complete";
    if (automation.triggerType === "card_assigned_to_user") return "Card assigned to";
    if (automation.triggerType === "card_marked_complete") return "Card marked complete";
    if (automation.triggerType === "card_label_set") return "Label set to";
    if (automation.triggerType === "custom_field_value_changed") return "Custom field changes to";
    if (automation.applyOnCreate && automation.applyOnMove) return "Card created or moved into";
    if (automation.applyOnCreate) return "Card created in";
    if (automation.applyOnMove) return "Card moved into";
    // Neither scope. Stay neutral in the sentence rather than mangling it — automationHasNoEntryType()
    // raises this as a warning in the card meta, where health signals live.
    return "Card enters";
  }

  /**
   * A list-entry rule with neither entry type can never fire, however healthy it otherwise looks.
   * Not reachable from the editor — the last remaining scope locks on — but the public API accepts
   * it, so the collapsed card has to be able to say so.
   */
  automationHasNoEntryType(automation: WireAutomation): boolean {
    return automation.triggerType === "card_enters_list" && !automation.applyOnCreate && !automation.applyOnMove;
  }

  automationTriggerTargetLabel(automation: WireAutomation): string | null { return automationTriggerTargetLabel(automation, this.automationLookups()); }

  automationActionSummarySegments(action: AutomationActionBody): AutomationSummarySegment[] { return automationActionSummarySegments(action, this.automationLookups()); }

  automationActionTargetLabel(action: AutomationActionBody): string | null { return automationActionTargetLabel(action, this.automationLookups()); }

  isAutomationLabelAction(action: AutomationActionBody): boolean { return isAutomationLabelAction(action); }

  automationActionLabelColor(action: AutomationActionBody): string | null { return automationActionLabelColor(action, this.automationLookups()); }

  automationActionSummary(action: AutomationActionBody): string { return automationActionSummary(action, this.automationLookups()); }

  automationActionIcon(action: AutomationActionBody): string { return automationActionIcon(action); }

  automationActionIconClass(action: AutomationActionBody): string { return automationActionIconClass(action); }

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

  automationLabelName(id: string): string { return automationLabelName(id, this.automationLookups()); }

  automationTriggerLabelName(id: string): string { return automationTriggerLabelName(id, this.automationLookups()); }

  automationMemberName(id: string): string { return automationMemberName(id, this.automationLookups()); }

  automationTemplateName(id: string): string { return automationTemplateName(id, this.automationLookups()); }

  automationCustomFieldName(id: string): string { return automationCustomFieldName(id, this.automationLookups()); }

  automationPopulateTextDateFormatLabel(format: PopulateTextDateFormat): string { return automationPopulateTextDateFormatLabel(format); }

  automationPopulateValueLabel(action: AutomationActionBody): string { return automationPopulateValueLabel(action, this.automationLookups()); }

  private isAutomationActionComplete(action: AutomationActionBody): boolean { return isAutomationActionComplete(action, this.automationLookups()); }

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
      triggerType: automation.triggerType === "card_leaves_list" || automation.triggerType === "due_date_arrives" || automation.triggerType === "due_date_approaching" || automation.triggerType === "card_becomes_inactive" || automation.triggerType === "all_checklist_items_complete" || automation.triggerType === "card_assigned_to_user" || automation.triggerType === "card_marked_complete" || automation.triggerType === "card_label_set" || automation.triggerType === "custom_field_value_changed" ? automation.triggerType : "card_enters_list",
      triggerListId: automation.triggerType === "card_enters_list" || automation.triggerType === "card_leaves_list" ? automation.triggerListId : null,
      triggerUserIds: automation.triggerType === "card_assigned_to_user" ? this.stringList(automation.triggerUserIds) : null,
      triggerLabelId: automation.triggerType === "card_label_set" ? automation.triggerLabelId : null,
      triggerCustomFieldId: automation.triggerType === "custom_field_value_changed" ? automation.triggerCustomFieldId : null,
      triggerCustomFieldValue: automation.triggerType === "custom_field_value_changed" ? automation.triggerCustomFieldValue : null,
      triggerDaysBefore: automation.triggerType === "due_date_approaching" ? automation.triggerDaysBefore : null,
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
    if (kind === "field") return { kind, sourceFieldId: this.stringValue(value["sourceFieldId"], "") };
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

  async addAutomation(e?: Event) {
    e?.preventDefault();
    const listId = this.lists()[0]?.id ?? null;
    if (!listId) return;
    await this.createAutomation({
      triggerType: "card_enters_list",
      triggerListId: listId,
      applyOnCreate: true,
      applyOnMove: true,
      actions: [this.defaultAutomationAction()],
    });
  }

  /**
   * Create one of the example automations, resolved against live workspace data at click time.
   *
   * Re-resolving here rather than trusting the row the admin clicked keeps the created rule honest:
   * a list or label deleted in another tab since the menu opened would otherwise be POSTed as a
   * dangling id and rejected by the API.
   */
  async applyAutomationRecipe(id: string) {
    if (!this.canDuplicateAutomation()) return;
    const recipe = automationRecipeCatalogue.find((candidate) => candidate.id === id);
    const resolved = recipe?.resolve({ lists: this.lists(), labels: this.labels(), templates: this.templates(), fields: this.fields() });
    if (!resolved) return;
    await this.createAutomation(resolved.body);
  }

  /** Copy an existing rule, including its actions. Lands disabled so it cannot fire before review. */
  async duplicateAutomation(id: string) {
    const source = this.automations().find((item) => item.id === id);
    if (!source) return;
    // Duplicate the draft rather than the server copy so in-progress edits carry over, minus any
    // action row that is still incomplete and would be rejected by the create DTO.
    const actions = this.automationDraftActions(id).filter((action) => this.isAutomationActionComplete(action));
    await this.createAutomation({
      triggerType: source.triggerType,
      triggerListId: source.triggerListId,
      triggerUserIds: source.triggerUserIds,
      triggerLabelId: source.triggerLabelId,
      triggerCustomFieldId: source.triggerCustomFieldId,
      triggerCustomFieldValue: source.triggerCustomFieldValue,
      triggerDaysBefore: source.triggerDaysBefore,
      applyOnCreate: source.applyOnCreate,
      applyOnMove: source.applyOnMove,
      actions,
    });
  }

  private async createAutomation(body: Record<string, unknown>) {
    if (!this.canDuplicateAutomation()) return;
    this.creatingAutomation.set(true);
    try {
      const automation = await this.api.post<WireAutomation>(`/workspaces/${this.workspaceId()}/automations`, body);
      const normalized = this.normalizeAutomation(automation);
      this.automations.update((items) => this.sortAutomations([...items.filter((item) => item.id !== normalized.id), normalized]));
      this.expandedAutomationIds.update((set) => new Set(set).add(normalized.id));
      this.ensureAutomationDraft(normalized.id);
    } finally {
      this.creatingAutomation.set(false);
    }
  }

  canAddAutomation(): boolean {
    // A new rule starts on card_enters_list, so it needs a list to point at. Duplicating an existing
    // rule does not — its trigger may not involve a list at all.
    return this.lists().length > 0 && this.canDuplicateAutomation();
  }

  canDuplicateAutomation(): boolean {
    return !this.automationLimitReached() && !this.creatingAutomation();
  }

  addAutomationHint(): string {
    if (this.lists().length === 0) return `Add a list to this ${this.entityLabel()} before creating an automation.`;
    if (this.automationLimitReached()) return this.automationLimitHint();
    return "New automation";
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
    const triggerListId = triggerType === "card_enters_list" || triggerType === "card_leaves_list" ? (current.triggerListId ?? this.lists()[0]?.id ?? null) : null;
    const triggerUserIds = triggerType === "card_assigned_to_user" ? (current.triggerUserIds?.length ? current.triggerUserIds : [this.automationMembers()[0]?.userId].filter((userId): userId is string => Boolean(userId))) : null;
    const triggerLabelId = triggerType === "card_label_set" ? (current.triggerLabelId ?? this.labels()[0]?.id ?? null) : null;
    const triggerDaysBefore = triggerType === "due_date_approaching" ? (current.triggerDaysBefore ?? 3) : null;
    const triggerCustomField = triggerType === "custom_field_value_changed"
      ? (this.automationTriggerCustomField(current) ?? this.automationTriggerCustomFields()[0] ?? null)
      : null;
    const triggerCustomFieldValue = triggerCustomField
      ? (current.triggerCustomFieldId === triggerCustomField.id && current.triggerCustomFieldValue?.kind === triggerCustomField.type
        ? current.triggerCustomFieldValue
        : this.defaultAutomationTriggerCustomFieldValue(triggerCustomField))
      : null;
    if (triggerType === "card_label_set" && !triggerLabelId) return;
    if (triggerType === "custom_field_value_changed" && (!triggerCustomField || !triggerCustomFieldValue)) return;
    const updated = await this.api.patch<WireAutomation>(`/automations/${id}`, {
      triggerType,
      triggerListId,
      triggerUserIds,
      triggerLabelId,
      triggerCustomFieldId: triggerCustomField?.id ?? null,
      triggerCustomFieldValue,
      triggerDaysBefore,
    });
    this.replaceAutomation(updated);
  }

  private defaultAutomationTriggerCustomFieldValue(field: WireCustomField): AutomationTriggerCustomFieldValueDto | null {
    if (field.type === "text") return { kind: "text", text: "" };
    if (field.type === "number") return { kind: "number", number: 0 };
    if (field.type === "checkbox") return { kind: "checkbox", checked: true };
    if (field.type === "date") return { kind: "date", date: new Date().toISOString().slice(0, 10) };
    if (field.type === "url") return { kind: "url", url: "https://example.com" };
    if (field.type === "select") return field.options[0]?.id ? { kind: "select", optionId: field.options[0].id } : null;
    const userId = this.automationMembers()[0]?.userId;
    return userId ? { kind: "user", userId } : null;
  }

  async updateAutomationTriggerList(id: string, triggerListId: string) {
    const updated = await this.api.patch<WireAutomation>(`/automations/${id}`, { triggerListId });
    this.replaceAutomation(updated);
  }

  async updateAutomationTriggerDaysBefore(id: string, value: number) {
    if (!Number.isFinite(value)) return;
    const triggerDaysBefore = Math.min(3650, Math.max(1, Math.trunc(value)));
    const updated = await this.api.patch<WireAutomation>(`/automations/${id}`, { triggerDaysBefore });
    this.replaceAutomation(updated);
  }

  async updateAutomationTriggerCustomField(id: string, triggerCustomFieldId: string) {
    const field = this.automationTriggerCustomFields().find((item) => item.id === triggerCustomFieldId);
    if (!field) return;
    const triggerCustomFieldValue = this.defaultAutomationTriggerCustomFieldValue(field);
    if (!triggerCustomFieldValue) return;
    const updated = await this.api.patch<WireAutomation>(`/automations/${id}`, { triggerCustomFieldId, triggerCustomFieldValue });
    this.replaceAutomation(updated);
  }

  async updateAutomationTriggerCustomFieldValue(id: string, triggerCustomFieldValue: AutomationTriggerCustomFieldValueDto) {
    const updated = await this.api.patch<WireAutomation>(`/automations/${id}`, { triggerCustomFieldValue });
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
    if (!this.canToggleAutomationApply(current, field)) return;
    const updated = await this.api.patch<WireAutomation>(`/automations/${id}`, { [field]: !current[field] });
    this.replaceAutomation(updated);
  }

  /**
   * A card_enters_list rule with both applyOnCreate and applyOnMove off can never match anything
   * (runListEntryAutomations filters on one column or the other), so it would sit there reading
   * "Enabled" while being structurally dead. Refuse to clear the last one.
   */
  canToggleAutomationApply(automation: WireAutomation, field: "applyOnCreate" | "applyOnMove"): boolean {
    if (!automation[field]) return true; // turning one on is always allowed
    return field === "applyOnCreate" ? automation.applyOnMove : automation.applyOnCreate;
  }

  /**
   * Null for the locked scope: the editor shows a persistent note under the group in that state, so
   * a hover tooltip repeating it would be redundant — and a tooltip is the wrong place for the one
   * explanation a touch user needs.
   */
  automationApplyToggleHint(automation: WireAutomation, field: "applyOnCreate" | "applyOnMove"): string | null {
    if (!this.canToggleAutomationApply(automation, field)) return null;
    const label = field === "applyOnCreate" ? "cards created in this list" : "cards moved into this list";
    return automation[field] ? `Stop running for ${label}` : `Also run for ${label}`;
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

  /**
   * add_labels/remove_labels carry a labelIds array, so the editor exposes a real multi-select rather
   * than a single dropdown that could only ever write the first element.
   */
  updateAutomationActionLabels(id: string, index: number, labelIds: string[]) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "add_labels" && action?.type !== "remove_labels") return;
    this.setAutomationDraftAction(id, index, { type: action.type, config: { labelIds } });
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

  // `defer` is set by the free-typing "Days from trigger" input; the preset dropdown routes through
  // here too and should commit at once.
  updateAutomationDueOffset(id: string, index: number, offsetDays: number, defer = false) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "set_due_date") return;
    this.setAutomationDraftAction(id, index, { type: "set_due_date", config: { ...action.config, offsetDays } });
    if (defer) this.queueAutomationActionsSave(id);
    else void this.saveAutomationActions(id);
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
    this.queueAutomationActionsSave(id);
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
    this.queueAutomationActionsSave(id);
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
    this.queueAutomationActionsSave(id);
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

  updateAutomationPopulateMode(id: string, index: number, mode: "value" | "field") {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "populate_custom_field") return;
    // Switching to "Copy from field" pre-selects the first eligible same-type source (if any);
    // switching back restores the literal-value default for the target field's type.
    const nextValue: PopulateCustomFieldValue =
      mode === "field"
        ? { kind: "field", sourceFieldId: this.automationPopulateSourceFields(action)[0]?.id ?? "" }
        : this.defaultPopulateValueForField(this.automationSetCustomField(action));
    this.setAutomationDraftAction(id, index, { type: "populate_custom_field", config: { ...action.config, value: nextValue } });
    void this.saveAutomationActions(id);
  }

  updateAutomationPopulateSourceField(id: string, index: number, sourceFieldId: string) {
    const action = this.automationDraftActions(id)[index];
    if (action?.type !== "populate_custom_field") return;
    this.setAutomationDraftAction(id, index, {
      type: "populate_custom_field",
      config: { ...action.config, value: { kind: "field", sourceFieldId } },
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
    this.clearQueuedAutomationActionsSave(id);
    // Incomplete actions cannot be persisted (the DTO rejects an empty labelIds/userIds), so they stay
    // in the draft and are surfaced in the editor as unsaved rather than vanishing without a word.
    const actions = this.automationDraftActions(id).filter((action) => this.isAutomationActionComplete(action));
    const automation = await this.api.put<WireAutomation>(`/automations/${id}/actions`, { actions });
    this.replaceAutomation(automation, true);
  }

  /**
   * Coalesce saves for the free-text value editors (text, number, date). Called on every keystroke;
   * only the trailing edit reaches the API, so one word of typing is one write instead of one per key.
   */
  private queueAutomationActionsSave(id: string) {
    this.clearQueuedAutomationActionsSave(id);
    this.pendingAutomationSaves.set(
      id,
      window.setTimeout(() => {
        this.pendingAutomationSaves.delete(id);
        void this.saveAutomationActions(id);
      }, AUTOMATION_ACTION_SAVE_DEBOUNCE_MS),
    );
  }

  private clearQueuedAutomationActionsSave(id: string) {
    const timer = this.pendingAutomationSaves.get(id);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    this.pendingAutomationSaves.delete(id);
  }

  /** Blur commits immediately so leaving a field never depends on the debounce still being alive. */
  flushAutomationActionsSave(id: string) {
    if (!this.pendingAutomationSaves.has(id)) return;
    void this.saveAutomationActions(id);
  }

  private flushAllAutomationActionSaves() {
    for (const id of Array.from(this.pendingAutomationSaves.keys())) this.flushAutomationActionsSave(id);
  }

  /** True while an action row is configured but not yet valid enough to persist. */
  isAutomationActionIncomplete(action: AutomationActionBody): boolean {
    return !this.isAutomationActionComplete(action);
  }

  /** What the admin still has to pick before an action row can be saved. */
  automationActionIssue(action: AutomationActionBody): string | null {
    if (this.isAutomationActionComplete(action)) return null;
    if (action.type === "add_labels" || action.type === "remove_labels") return "Pick at least one label to save this action.";
    if (action.type === "add_assignees" || action.type === "remove_assignees") return "Pick at least one member to save this action.";
    if (action.type === "apply_checklists") return "Pick at least one checklist template to save this action.";
    if (action.type === "move_to_list") return "Pick a destination list to save this action.";
    if (action.type === "populate_custom_field") {
      if (!action.config.fieldId) return "Pick a custom field to save this action.";
      const field = this.automationSetCustomField(action);
      if (!field) return "This custom field no longer exists. Pick another one.";
      const value = action.config.value;
      if (value.kind === "field") return "Pick a source field of the same type to save this action.";
      if (value.kind === "text") return "Enter the text to write to save this action.";
      if (value.kind === "date" && value.source === "fixed") return "Pick a date to save this action.";
      if (value.kind === "select") return field.allowMultiple ? "Pick at least one option to save this action." : "Pick exactly one option to save this action.";
      if (value.kind === "user") return field.allowMultiple ? "Pick at least one member to save this action." : "Pick exactly one member to save this action.";
      return "Finish configuring this action to save it.";
    }
    return "Finish configuring this action to save it.";
  }

  /** Count of draft rows the server has not accepted, for the "n unsaved" marker in the rule head. */
  automationIncompleteActionCount(id: string): number {
    return this.automationDraftActions(id).filter((action) => !this.isAutomationActionComplete(action)).length;
  }

  // ── Run stats (from automation_run_stats, exposed on the automation payload) ──

  /**
   * A rule is flagged as failing only when its *most recent* run failed. `lastRunAt` is stamped on
   * every outcome and shares the same timestamp as the outcome-specific column written in the same
   * statement, so equality here means "the last thing this rule did was fail" — a rule that failed
   * once months ago and has worked since is not shown as broken.
   */
  automationLastRunFailed(automation: WireAutomation): boolean {
    const stats = automation.runStats;
    if (!stats?.lastFailedRunAt || !stats.lastRunAt) return false;
    return automationTimestamp(stats.lastFailedRunAt) === automationTimestamp(stats.lastRunAt);
  }

  automationFailureMessage(automation: WireAutomation): string | null {
    return this.automationLastRunFailed(automation) ? automation.runStats?.lastFailureMessage ?? null : null;
  }

  automationLastRunLabel(automation: WireAutomation): string {
    const stats = automation.runStats;
    if (!stats?.lastRunAt) return automation.enabled ? "Not run yet" : "Never run";
    return `Ran ${formatRelativeTime(stats.lastRunAt)}`;
  }

  /**
   * Collapsed-head variant: a disabled rule that has never run is the normal state of a rule being
   * built, so it earns no line in the head. The expanded run-history footer still says so.
   */
  automationHeadRunLabel(automation: WireAutomation): string | null {
    if (!automation.runStats?.lastRunAt && !automation.enabled) return null;
    return this.automationLastRunLabel(automation);
  }

  /**
   * Only used to tell "has run" from "has never run". The individual outcome counters are lifetime
   * totals that only grow, so they are not surfaced: a working rule eventually reads "102,231
   * applied", which tells an admin nothing. Recency and the last failure do.
   */
  automationRunCount(automation: WireAutomation): number {
    return automation.runStats?.runCount ?? 0;
  }

  /** True for an enabled rule that has never fired — usually a sign the trigger does not match. */
  automationNeverRan(automation: WireAutomation): boolean {
    return automation.enabled && !automation.runStats?.lastRunAt;
  }

  /**
   * Null when the most recent run was the effectful one. Both columns are stamped with the same
   * `now` in that case, so showing it would just repeat "Ran 20m ago" in different words. The
   * interesting case is a gap between the two: the rule still fires but has stopped changing
   * anything, which usually means the cards it matches already look the way it wants.
   */
  automationLastEffectiveLabel(automation: WireAutomation): string | null {
    const stats = automation.runStats;
    if (!stats?.lastEffectfulRunAt || !stats.lastRunAt) return null;
    if (automationTimestamp(stats.lastEffectfulRunAt) === automationTimestamp(stats.lastRunAt)) return null;
    return formatRelativeTime(stats.lastEffectfulRunAt);
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
    if (!existing || this.isInheritedWorkspaceAdmin(existing)) return;
    const member = await this.api.patch<MemberRow>(`/workspaces/${this.workspaceId()}/members/${userId}`, { role });
    this.members.update((rows) => rows.map((r) => (r.userId === userId ? { ...r, role: member.role } : r)));
  }

  private async reconcileCurrentSettingsAccess(): Promise<void> {
    const members = await this.api.get<MemberRow[]>(`/workspaces/${this.workspaceId()}/members`).catch(() => null);
    if (!members) {
      await this.router.navigate(["/"]);
      return;
    }
    this.members.set(members);
    const current = members.find((member) => member.userId === this.currentUserId());
    if (current?.role !== "admin") await this.router.navigate(["/"]);
  }

  isInheritedWorkspaceAdmin(member: MemberRow): boolean {
    return member.orgRole === "owner" || member.orgRole === "admin";
  }

  async addMember(e: Event) {
    e.preventDefault();
    const userId = this.addMemberUserId();
    if (!userId) return;
    const member = await this.api.post<MemberRow>(`/workspaces/${this.workspaceId()}/members`, {
      userId,
      role: this.addMemberRole(),
    });
    this.members.update((rows) => rows.some((row) => row.userId === member.userId) ? rows : [...rows, member]);
    this.addMemberUserId.set("");
    this.addMemberRole.set("member");
  }

  async removeMember(userId: string) {
    const member = this.members().find((m) => m.userId === userId);
    if (!member || this.isInheritedWorkspaceAdmin(member)) return;
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
        assignedItemsOnly: this.guestAssignedItemsOnly(),
      });
      if (preview.paidGuestSeatRequired) {
        // Paid guest seats come from the org's pre-purchased pool. Explain that before the mutation,
        // because the next request will allocate the seat immediately for existing external users.
        const confirmed = await this.confirm.open({
          title: "This guest will use a paid seat",
          message: "A guest's first board is free. Adding their second board uses one of your purchased seats; further boards reuse that seat. Your bill will not change right now, and the seat becomes available again when their access returns to one board.",
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
        assignedItemsOnly: this.guestAssignedItemsOnly(),
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
      this.guestAssignedItemsOnly.set(false);
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

  async updateGuestAssignedItemsOnly(guest: AcceptedGuestRow, assignedItemsOnly: boolean) {
    if (this.guestAccessUpdatingId()) return;
    if (guest.assignedItemsOnly === assignedItemsOnly) return;
    const key = `${guest.boardId}:${guest.userId}`;
    const previous = this.acceptedGuests();
    this.guestAccessUpdatingId.set(key);
    this.guestError.set(null);
    this.acceptedGuests.update((rows) => rows.map((row) =>
      row.boardId === guest.boardId && row.userId === guest.userId ? { ...row, assignedItemsOnly } : row,
    ));
    try {
      await this.api.patch(`/boards/${guest.boardId}/members/${guest.userId}`, {
        role: guest.role,
        assignedItemsOnly,
      });
    } catch (error) {
      this.acceptedGuests.set(previous);
      this.guestError.set(extractErrorMessage(error));
    } finally {
      this.guestAccessUpdatingId.set(null);
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

  openBoardAccess(boardId: string) {
    this.managingBoardAccessId.update((current) => current === boardId ? null : boardId);
  }

  /**
   * Close board `boardId`'s access menu, but only if it is still the open one.
   *
   * The identity check is load-bearing. Clicking row B's access button while row A's menu is open runs
   * `openBoardAccess(B)` at the event target first, and then the same click reaches PanelStackService,
   * which dismisses A — still mounted. An unconditional `set(null)` there would wipe the id just
   * written, so A closed, B never opened, and the user had to click twice. Any signal that multiplexes
   * several popovers by id or kind needs this guard on its dismissal path.
   */
  closeBoardAccess(boardId: string) {
    this.managingBoardAccessId.update((current) => current === boardId ? null : current);
  }

  async deleteWorkspace() {
    const ws = this.workspace();
    if (!ws) return;
    // Deleting a workspace is a workspace-admin (or org-admin) action.
    if (!this.canManageApi()) return;
    if (!await this.confirm.open({
      title: `Are you sure you want to delete ${this.entityLabel()} "${ws.name}"?`,
      message: this.isStandalone()
        ? "This will permanently delete this board, its lists, cards, attachments and settings."
        : "This will permanently delete all boards, lists, attachments and cards inside it.",
      confirmLabel: this.isStandalone() ? "Delete board" : "Delete workspace",
      confirmationText: ws.name,
    })) return;
    await this.api.delete(`/workspaces/${this.workspaceId()}`, { confirmationName: ws.name });
    const remainingWorkspaces = await this.api.get<Workspace[]>("/workspaces");
    const hasWorkspace = remainingWorkspaces.length > 0;
    this.auth.updateUser((u) => ({ ...u, hasWorkspace }));
    const home = await this.api.get<{ groups?: { workspace: { kind?: string }; boards: unknown[] }[]; guestGroups?: { boards: unknown[] }[] }>("/home/boards").catch(() => null);
    const hasOtherBoardAccess = home?.groups?.some((group) => group.boards.length > 0) || home?.guestGroups?.some((group) => group.boards.length > 0);
    await this.router.navigateByUrl(hasWorkspace || hasOtherBoardAccess ? "/" : "/onboarding");
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
    if (this.boardLimitReached()) {
      await this.openUpgradePrompt("board");
      return;
    }
    const name = this.newBoardName().trim();
    if (!name) return;
    const board = await this.api.post<Board>(`/workspaces/${this.workspaceId()}/boards`, { name });
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
    if (!board || this.deletionPreviewKey()) return;
    this.deletionPreviewKey.set(`board:${id}`);
    try {
      const confirmed = await this.confirm.openAfterLoading({
        title: `Delete "${board.name}"?`,
        loadingMessage: "Checking how many cards will be deleted...",
      }, async () => {
        const { cardCount } = await this.api.get<DeletionImpactResponse>(`/boards/${id}/deletion-impact`);
        const cardLabel = cardCount === 1 ? "card" : "cards";
        return `${cardCount} ${cardLabel} will also be permanently deleted. Are you sure?`;
      });
      if (!confirmed) return;
      await this.api.delete(`/boards/${id}`);
      this.removeGuestBoard(id);
    } finally {
      this.deletionPreviewKey.set(null);
    }
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
      this.apiKeys.update((keys) => sortWorkspaceApiKeys([...keys, created]));
      this.revealedApiKeySecret.set(created.secret);
      this.newApiKeyName.set("");
      this.newApiKeyScope.set("write");
    } catch (error) {
      this.apiKeyError.set(extractErrorMessage(error));
    }
  }

  async openUpgradePrompt(reason: UpgradePromptReason): Promise<void> {
    await this.upgradePrompt.open({
      reason,
      source: "workspace_settings",
      boardCount: this.boardList().length,
      automationAllowance: this.auth.maxAutomationExecutionsPerMonth() ?? undefined,
      currentUsage: reason === "automationRule"
        ? this.automations().filter((automation) => automation.enabled).length
        : reason === "automation"
        ? Math.max(0, (this.auth.maxAutomationExecutionsPerMonth() ?? 0) - (this.automationExecutionsRemaining() ?? 0))
        : undefined,
    });
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

  startEditApiKey(key: WorkspaceApiKeyRow) {
    this.editingApiKeyId.set(key.id);
    this.editingApiKeyName.set(key.name);
    this.apiKeyError.set(null);
  }

  cancelEditApiKey() {
    this.editingApiKeyId.set(null);
    this.editingApiKeyName.set("");
  }

  async saveApiKeyName(id: string) {
    const name = this.editingApiKeyName().trim();
    const current = this.apiKeys().find((key) => key.id === id);
    if (!current || !name) return;
    if (name === current.name) {
      this.cancelEditApiKey();
      return;
    }
    this.apiKeyError.set(null);
    try {
      const updated = await this.api.patch<WorkspaceApiKeyRow>(`/workspaces/${this.workspaceId()}/api-keys/${id}`, { name });
      this.apiKeys.update((keys) => keys.map((key) => key.id === id ? updated : key));
      this.cancelEditApiKey();
    } catch (error) {
      // Leave the editor open so the admin can correct the name without re-entering it.
      this.apiKeyError.set(extractErrorMessage(error));
    }
  }

  async createAgentConnection(e: Event) {
    e.preventDefault();
    const name = this.newAgentConnectionName().trim();
    if (!name) return;
    this.agentConnectionError.set(null);
    try {
      const created = await this.api.post<AgentConnectionRow & { clientSecret: string; tokenEndpoint: string }>(`/workspaces/${this.workspaceId()}/agent-connections`, {
        name,
        scope: this.newAgentConnectionScope(),
      });
      this.agentConnections.update((items) => [created, ...items]);
      this.revealedAgentCredential.set({ clientId: created.clientId, clientSecret: created.clientSecret, tokenEndpoint: created.tokenEndpoint });
      this.newAgentConnectionName.set("");
      this.newAgentConnectionScope.set("write");
    } catch (error) {
      this.agentConnectionError.set(extractErrorMessage(error));
    }
  }

  async deleteAgentConnection(clientId: string) {
    const connection = this.agentConnections().find((item) => item.clientId === clientId);
    if (!connection) return;
    if (!await this.confirm.open({ title: `Delete "${connection.name}"?`, message: "This agent's OAuth tokens will stop working immediately." })) return;
    await this.api.delete(`/workspaces/${this.workspaceId()}/agent-connections/${clientId}`);
    this.agentConnections.update((items) => items.filter((item) => item.clientId !== clientId));
  }

  formatApiKeyLastUsed(value: string | Date | null | undefined): string {
    if (!value) return "Never";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "Never";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  formatWebhookLastSuccessful(value: string | Date | null | undefined): string {
    return this.formatApiKeyLastUsed(value);
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
