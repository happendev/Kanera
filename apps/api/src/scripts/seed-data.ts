import type { ColorToken } from "@kanera/shared/colors";
import { cardPath } from "@kanera/shared/card-links";
import { DEFAULT_WORKSPACE_CUSTOM_FIELDS } from "@kanera/shared/default-workspace-custom-fields";
import { DEFAULT_WORKSPACE_LABELS } from "@kanera/shared/default-workspace-labels";
import {
  ACTIVITY_ACTION,
  activityEvents,
  boardMembers,
  boards,
  boardSeparators,
  cardAssignees,
  cardAttachments,
  cardChecklistItems,
  cardChecklists,
  cardCustomFieldValues,
  cardLabelAssignments,
  cardLabels,
  cardMentions,
  cards,
  cardWatchers,
  clientMembers,
  clients,
  comments,
  customFieldOptions,
  customFields,
  internalLinks,
  lists,
  noteAttachments,
  notes,
  notifications,
  users,
  workspaceMembers,
  workspaces,
  type ActivityAction,
  type ActivityEntityType,
  type CardDueDateSlot,
  type ClientRole,
  type NoteScope,
} from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../auth/password.js";
import { db, type Db } from "../db.js";
import { env } from "../env.js";
import { recordActivity } from "../lib/activity.js";
import { seedBoardMembersFromWorkspace } from "../lib/board-membership.js";
import { allocateCardKeys } from "../lib/card-keys.js";
import { generateCoverImage, generateThumbnail, isProcessableImage } from "../lib/image.js";
import { unsignedMediaUrl } from "../lib/media-keys.js";
import { createStorageForConfig, getConfiguredS3StorageConfig, type StorageProvider } from "../lib/storage/index.js";
import {
  attachmentCoverStorageKey,
  attachmentThumbnailStorageKey,
  avatarStorageKey,
  cardAttachmentStorageKey,
  noteAttachmentStorageKey,
} from "../lib/storage/keys.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type SeedUserKey =
  | "amelia"
  | "marcus"
  | "priya"
  | "ben"
  | "nina"
  | "zoe"
  | "leo"
  | "omar"
  | "grace"
  | "henry"
  | "maya";

type SeedWorkspaceKey = "development" | "marketing" | "devops";
type AssetKey = keyof typeof ATTACHMENT_ASSETS;
type SeedGender = "female" | "male";

type SeedUser = {
  key: SeedUserKey;
  email: string;
  displayName: string;
  gender: SeedGender;
  avatarFileName: string;
  timezone: string;
  clientRole: ClientRole;
};

// Seed data still expresses intent in the legacy four-tier vocabulary; it is mapped to the current
// workspace (admin/member) and board (editor/observer) scales at insertion time.
type SeedRole = "owner" | "admin" | "editor" | "observer";
type SeedMember = {
  user: SeedUserKey;
  role: SeedRole;
};

const toWorkspaceRole = (role: SeedRole): "admin" | "member" => (role === "owner" || role === "admin" ? "admin" : "member");
const toBoardRole = (role: SeedRole): "editor" | "observer" => (role === "observer" ? "observer" : "editor");

type SeedList = {
  name: string;
  icon?: string;
  color?: ColorToken;
};

type SeedCustomField = {
  name: string;
  icon?: string;
  type: "text" | "number" | "checkbox" | "select";
  options?: { label: string }[];
  showOnCard?: boolean;
};

type SeedLabel = {
  name: string;
  color: ColorToken;
};

type SeedAttachment = {
  asset: AssetKey;
  uploadedBy: SeedUserKey;
  useAsCover?: boolean;
};

type SeedComment = {
  author: SeedUserKey;
  body: string;
  hoursAfterCreation: number;
  mentions?: SeedUserKey[];
  unreadFor?: SeedUserKey[];
};

type SeedChecklistItem = {
  text: string;
  assignee?: SeedUserKey;
  dueOffsetDays?: number;
  dueDateSlot?: CardDueDateSlot;
  completedBy?: SeedUserKey;
  completedOffsetHours?: number;
};

type SeedChecklist = {
  title: string;
  items: SeedChecklistItem[];
};

type SeedFieldValue = string | number | boolean;

type SeedCard = {
  title: string;
  description: string;
  list: string;
  createdBy: SeedUserKey;
  assignees: SeedUserKey[];
  labels: string[];
  dueOffsetDays?: number;
  dueDateSlot?: CardDueDateSlot;
  fieldValues?: Record<string, SeedFieldValue>;
  attachments?: SeedAttachment[];
  checklists?: SeedChecklist[];
  comments?: SeedComment[];
  watchers?: SeedUserKey[];
  completedBy?: SeedUserKey;
  completedDaysAgo?: number;
  createdDaysAgo?: number;
};

type SeedSeparator = {
  title: string;
  list: string;
  position: string;
  createdBy: SeedUserKey;
  color?: ColorToken;
};

type SeedNote = {
  title: string;
  content: string;
  icon?: string;
  scope?: NoteScope;
  owner: SeedUserKey;
  attachments?: SeedAttachment[];
  children?: SeedNote[];
};

type SeedBoard = {
  key: string;
  name: string;
  description: string;
  icon: string;
  iconColor: ColorToken;
  createdBy: SeedUserKey;
  members?: SeedMember[];
  notes?: SeedNote[];
  separators?: SeedSeparator[];
  cards: SeedCard[];
};

type SeedWorkspace = {
  key: SeedWorkspaceKey;
  name: string;
  icon: string;
  accentColor: ColorToken;
  createdBy: SeedUserKey;
  members: SeedMember[];
  lists: SeedList[];
  customFields: SeedCustomField[];
  labels: SeedLabel[];
  notes?: SeedNote[];
  boards: SeedBoard[];
  // When set, cards in this workspace are given a plausible "worked-in" history: their created and
  // moved audit rows are written at real historical timestamps so a card's activity feed reads
  // created -> moved -> discussed -> completed in true order. `listFlow` is the happy-path list
  // progression; `listSideEntries` maps a side-state list (e.g. "Waiting on Others") to the flow
  // list it is normally reached from. Workspaces without a flow keep the simpler created-only history.
  listFlow?: readonly string[];
  listSideEntries?: Readonly<Record<string, string>>;
};

type AttachmentAsset = {
  relativePath: string[];
  mimeType: string;
};

export type SeedSummary = {
  users: number;
  workspaces: number;
  boards: number;
  cards: number;
  checklists: number;
  checklistItems: number;
  comments: number;
  separators: number;
  attachments: number;
  cardCovers: number;
  cardMoves: number;
  notes: number;
  internalLinks: number;
  mentions: number;
  notifications: number;
};

type SeedNotesResult = {
  notes: number;
  attachments: number;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../..");
export const DEV_SEED_SHARED_PASSWORD = "Abc12345";
export const DEMO_SEED_PRIMARY_EMAIL = "amelia@kanera.test";

const ATTACHMENT_ASSETS = {
  workspaceTemplateSymbol: {
    relativePath: ["images", "workspace-template-symbol.png"],
    mimeType: "image/png",
  },
  realtimeSyncSymbol: {
    relativePath: ["images", "realtime-sync-symbol.png"],
    mimeType: "image/png",
  },
  accessReviewSymbol: {
    relativePath: ["images", "access-review-symbol.png"],
    mimeType: "image/png",
  },
  billingExportDuplicate: {
    relativePath: ["images", "billing-export-duplicate.jpg"],
    mimeType: "image/jpeg",
  },
  iosReminderMissingTitle: {
    relativePath: ["images", "ios-reminder-missing-title.jpg"],
    mimeType: "image/jpeg",
  },
  androidLabelClipping: {
    relativePath: ["images", "android-label-clipping.jpg"],
    mimeType: "image/jpeg",
  },
  realtimeBoardCover: {
    relativePath: ["images", "realtime-board-reconnect.jpg"],
    mimeType: "image/jpeg",
  },
  mobileNotificationCover: {
    relativePath: ["images", "mobile-notification-qa.jpg"],
    mimeType: "image/jpeg",
  },
  campaignReviewCover: {
    relativePath: ["images", "campaign-review-studio.jpg"],
    mimeType: "image/jpeg",
  },
  campaignLaunchReadiness: {
    relativePath: ["images", "campaign-launch-readiness.jpg"],
    mimeType: "image/jpeg",
  },
  workerIncidentCover: {
    relativePath: ["images", "worker-incident-dashboard.jpg"],
    mimeType: "image/jpeg",
  },
  accessReviewCover: {
    relativePath: ["images", "access-review-evidence.jpg"],
    mimeType: "image/jpeg",
  },
  orphanedAttachmentCleanup: {
    relativePath: ["images", "orphaned-attachment-cleanup.jpg"],
    mimeType: "image/jpeg",
  },
  offlineCardSkeleton: {
    relativePath: ["images", "offline-card-skeleton.jpg"],
    mimeType: "image/jpeg",
  },
  tabletBoardOverview: {
    relativePath: ["images", "tablet-board-overview.jpg"],
    mimeType: "image/jpeg",
  },
  mobileAttachmentQa: {
    relativePath: ["images", "mobile-attachment-qa.jpg"],
    mimeType: "image/jpeg",
  },
  reliabilityCampaignBrief: {
    relativePath: ["images", "reliability-campaign-brief.jpg"],
    mimeType: "image/jpeg",
  },
  compactMobileChecklist: {
    relativePath: ["images", "compact-mobile-checklist.jpg"],
    mimeType: "image/jpeg",
  },
  webinarNurtureClips: {
    relativePath: ["images", "webinar-nurture-clips.jpg"],
    mimeType: "image/jpeg",
  },
  screenshotRedlineReview: {
    relativePath: ["images", "screenshot-redline-review.jpg"],
    mimeType: "image/jpeg",
  },
  contentOperationsTrendsResearch: {
    relativePath: ["images", "content-operations-trends-research.jpg"],
    mimeType: "image/jpeg",
  },
  contentCustomerInterviewRecording: {
    relativePath: ["images", "content-customer-interview-recording.jpg"],
    mimeType: "image/jpeg",
  },
  contentInterviewPreparation: {
    relativePath: ["images", "content-interview-preparation.jpg"],
    mimeType: "image/jpeg",
  },
  contentQuarterlyCalendar: {
    relativePath: ["images", "content-quarterly-calendar.jpg"],
    mimeType: "image/jpeg",
  },
  contentCustomerStoryDraft: {
    relativePath: ["images", "content-customer-story-draft.jpg"],
    mimeType: "image/jpeg",
  },
  contentNewsletterAssembly: {
    relativePath: ["images", "content-newsletter-assembly.jpg"],
    mimeType: "image/jpeg",
  },
  contentAnnouncementEdit: {
    relativePath: ["images", "content-announcement-edit.jpg"],
    mimeType: "image/jpeg",
  },
  contentEditorialReview: {
    relativePath: ["images", "content-editorial-review.jpg"],
    mimeType: "image/jpeg",
  },
  contentNewsletterApproval: {
    relativePath: ["images", "content-newsletter-approval.jpg"],
    mimeType: "image/jpeg",
  },
  contentBenchmarkValidation: {
    relativePath: ["images", "content-benchmark-validation.jpg"],
    mimeType: "image/jpeg",
  },
  apiRolloutPlan: {
    relativePath: ["pdfs", "api-rollout-plan.pdf"],
    mimeType: "application/pdf",
  },
  onboardingChecklist: {
    relativePath: ["pdfs", "engineering-onboarding-checklist.pdf"],
    mimeType: "application/pdf",
  },
  architectureRecord: {
    relativePath: ["docx", "architecture-decision-record.docx"],
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  releaseTemplate: {
    relativePath: ["docx", "release-readiness-template.docx"],
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  retroNotes: {
    relativePath: ["docx", "sprint-retrospective-notes.docx"],
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  northstarLogo: {
    relativePath: ["logos", "northstar-logo.svg"],
    mimeType: "image/svg+xml",
  },
  orbiflowLogo: {
    relativePath: ["logos", "orbiflow-logo.jpg"],
    mimeType: "image/jpeg",
  },
  sprintforgeLogo: {
    relativePath: ["logos", "sprintforge-logo.jpg"],
    mimeType: "image/jpeg",
  },
} satisfies Record<string, AttachmentAsset>;

const USER_SEEDS: SeedUser[] = [
  { key: "amelia", email: "amelia@kanera.test", displayName: "Amelia Hart", gender: "female", avatarFileName: "amelia-hart.webp", timezone: "Europe/London", clientRole: "owner" },
  { key: "marcus", email: "marcus@kanera.test", displayName: "Marcus Cole", gender: "male", avatarFileName: "marcus-cole.webp", timezone: "America/New_York", clientRole: "admin" },
  { key: "priya", email: "priya@kanera.test", displayName: "Priya Nair", gender: "female", avatarFileName: "priya-nair.webp", timezone: "Europe/London", clientRole: "member" },
  { key: "ben", email: "ben@kanera.test", displayName: "Ben Ortega", gender: "male", avatarFileName: "ben-ortega.webp", timezone: "America/Los_Angeles", clientRole: "member" },
  { key: "nina", email: "nina@kanera.test", displayName: "Nina Park", gender: "female", avatarFileName: "nina-park.webp", timezone: "America/Chicago", clientRole: "member" },
  { key: "zoe", email: "zoe@kanera.test", displayName: "Zoe Mitchell", gender: "female", avatarFileName: "zoe-mitchell.webp", timezone: "Australia/Sydney", clientRole: "member" },
  { key: "leo", email: "leo@kanera.test", displayName: "Leo Santos", gender: "male", avatarFileName: "leo-santos.webp", timezone: "America/Sao_Paulo", clientRole: "member" },
  { key: "omar", email: "omar@kanera.test", displayName: "Omar Ibrahim", gender: "male", avatarFileName: "omar-ibrahim.webp", timezone: "Africa/Cairo", clientRole: "member" },
  { key: "grace", email: "grace@kanera.test", displayName: "Grace Liu", gender: "female", avatarFileName: "grace-liu.webp", timezone: "Asia/Singapore", clientRole: "member" },
  { key: "henry", email: "henry@kanera.test", displayName: "Henry Walsh", gender: "male", avatarFileName: "henry-walsh.webp", timezone: "Europe/Dublin", clientRole: "member" },
];

const orgRoleByUser = new Map(USER_SEEDS.map((user) => [user.key, user.clientRole]));
const isSeedOrgAdmin = (user: SeedUserKey): boolean => {
  const role = orgRoleByUser.get(user);
  return role === "owner" || role === "admin";
};

const GUEST_USER_SEED: SeedUser = {
  key: "maya",
  email: "maya@external.test",
  displayName: "Maya Chen",
  gender: "female",
  avatarFileName: "maya-chen.webp",
  timezone: "America/Toronto",
  clientRole: "owner",
};

export const DEMO_SEED_LOGIN_EMAILS = [...USER_SEEDS, GUEST_USER_SEED].map((user) => user.email);

export type SeedDatabaseOptions = {
  /**
   * The development CLI deliberately requires an empty database. The admin demo reset targets only
   * the reserved demo tenants, so it seeds alongside unrelated production tenants after purging them.
   */
  requireBlankDatabase?: boolean;
  password?: string;
  paid?: boolean;
  analyticsExcluded?: boolean;
};

export type SeedDatabaseResult = {
  summary: SeedSummary;
  primaryClientId: string;
  guestClientId: string;
};

const seedUserByKey = new Map([...USER_SEEDS, GUEST_USER_SEED].map((user) => [user.key, user]));

function note(...sections: string[]): string {
  return sections.join("\n\n");
}

function realisticSeedCardDescription(card: SeedCard): string {
  const sections = card.description.split(/\n\n+/).filter((section) => section.trim().length > 0);
  if (sections.length < 2) return card.description;

  // Seed cards should read like cards people actually keep around: an idea, backlog item, or
  // completed outcome is often a single useful sentence, while active work earns more context
  // when it has a checklist, discussion, or attachment to support that detail.
  const briefLists = new Set(["Ideas & Requests", "Backlog", "Wishlist", "Done", "Completed"]);
  if (briefLists.has(card.list)) return sections[0]!;

  const hasSupportingDetail = Boolean(
    card.checklists?.length || card.comments?.length || card.attachments?.length || card.watchers?.length,
  );
  if (!hasSupportingDetail && [
    "Awaiting Feedback",
    "Monitoring",
    "Follow-up",
    "Planning / Review",
    "Ready for QA",
    "Awaiting Window",
  ].includes(card.list)) {
    return sections[0]!;
  }

  return card.description;
}

function seedMonth(offset = 0): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

function seedMonthLabel(offset = 0): string {
  return seedMonth(offset).toISOString().slice(0, 7);
}

function seedMonthName(offset = 0): string {
  return seedMonth(offset).toLocaleString("en", { month: "long", timeZone: "UTC" });
}

function buildWorkspaceSeeds(): SeedWorkspace[] {
  const workspaceSeeds = [buildDevelopmentWorkspace(), buildMarketingWorkspace(), buildDevopsWorkspace()];
  for (const workspace of workspaceSeeds) {
    for (const board of workspace.boards) {
      const showcaseCards = extraCardsForBoard(board.key).map((card, index) => ({
        ...card,
        // Keep the most screenshot-worthy conversations recent and place their cards first in
        // each matching list, while the older fixtures provide depth below the fold.
        createdDaysAgo: index === 0 ? 3 : 8,
      }));
      board.cards.unshift(...showcaseCards);
      board.cards = board.cards.map((card) => ({
        ...card,
        description: realisticSeedCardDescription(card),
      }));
    }
  }
  return workspaceSeeds;
}

function buildDevelopmentWorkspace(): SeedWorkspace {
  return {
    key: "development",
    name: "Development Team",
    icon: "code",
    accentColor: "sky",
    createdBy: "amelia",
    members: [
      { user: "amelia", role: "owner" },
      { user: "marcus", role: "admin" },
      { user: "priya", role: "admin" },
      { user: "ben", role: "editor" },
      { user: "nina", role: "editor" },
      { user: "omar", role: "editor" },
      { user: "grace", role: "observer" },
      { user: "zoe", role: "observer" },
    ],
    lists: [
      { name: "Wishlist", icon: "star" },
      { name: "Planning / Review", icon: "clipboard-list" },
      { name: "Backlog", icon: "list" },
      { name: "Bugs / Issues / Feedback", icon: "bug" },
      { name: "Awaiting Feedback", icon: "message-dots" },
      { name: "In Progress", icon: "progress" },
      { name: "Ready for QA", icon: "checklist" },
      { name: "Complete", icon: "circle-check" },
    ],
    customFields: [
      ...DEFAULT_WORKSPACE_CUSTOM_FIELDS.map((field) => ({ ...field })),
      {
        name: "Client",
        icon: "building",
        type: "select",
        options: [
          { label: "Sprintforge" },
          { label: "Orbiflow" },
          { label: "Northstar" },
        ],
      },
    ],
    labels: DEFAULT_WORKSPACE_LABELS.map((label) => ({ ...label })),
    notes: [
      {
        title: "Engineering Handbook",
        icon: "notebook",
        owner: "amelia",
        content: note(
          "📘 Shared engineering reference for how Development work moves through Kanera.",
          "Use this as the first stop for release expectations, branch naming, QA handoff, and where to record decisions that affect multiple boards.",
          "Reference: https://docs.kanera.app/engineering-handbook",
        ),
        children: [
          {
            title: "Release Process",
            icon: "rocket",
            owner: "priya",
            attachments: [{ asset: "releaseTemplate", uploadedBy: "priya" }],
            content: note(
              "Every release should have a board card with owner, due date, branch, acceptance notes, and rollback notes before it enters Ready for QA.",
              "- ✅ Confirm custom field values are filled in\n- 📎 Attach release evidence when it helps future audits\n- 🧪 Leave a short comment when QA signs off",
              "Release checklist: https://docs.kanera.app/releases/checklist",
            ),
          },
          {
            title: "Branching Guide",
            icon: "git-branch",
            owner: "priya",
            content: note(
              "Use `feature/`, `fix/`, `docs/`, and `chore/` prefixes so reporting can group delivery work cleanly.",
              "Hotfix branches should include the customer impact in the linked card before deployment.",
            ),
          },
        ],
      },
      {
        title: "API & Realtime Contracts",
        icon: "plug-connected",
        owner: "marcus",
        content: note(
          "Shared contract notes for API mutations, Socket.IO events, and public integration behavior.",
          "Mutation routes should validate the DTO, enforce workspace or board access, write data, record activity when the route's model expects it, and emit the matching realtime event.",
          "Board events stay in board rooms. Workspace events stay in workspace rooms. Event payloads should carry full entities so connected clients can update without guessing.",
          "API reference: https://docs.kanera.app/api",
        ),
      },
      {
        title: "Weekly Focus",
        icon: "target-arrow",
        scope: "personal",
        owner: "amelia",
        content: note(
          "Personal focus list for the week.",
          "- 🎯 Keep template rollout small and demoable\n- 💸 Review billing export retry fix before finance review\n- 🚪 Check that onboarding still runs when `me.hasWorkspace === false`",
        ),
      },
    ],
    boards: [
      {
        key: "platform-delivery",
        name: "Platform Delivery",
        description: "Cross-team delivery board for backend platform, shared services, and release coordination.",
        icon: "stack-2",
        iconColor: "blue",
        createdBy: "amelia",
        notes: [
          {
            title: "Project Template Rollout Plan",
            icon: "template",
            owner: "priya",
            attachments: [
              { asset: "workspaceTemplateSymbol", uploadedBy: "priya", useAsCover: true },
              { asset: "architectureRecord", uploadedBy: "priya" },
            ],
            content: note(
              "Demo note for the workspace template rollout work.",
              "Goal: let a new workspace start with opinionated boards, shared lists, default custom fields, and practical labels without hand setup.",
              "Open questions: migration-safe payload shape, whether templates can be edited later, and which QA checks prove onboarding is still reliable.",
              "Prototype spec: https://docs.kanera.app/templates/workspace-rollout",
            ),
          },
          {
            title: "Billing Export Retry Notes",
            icon: "receipt",
            owner: "omar",
            content: note(
              "Investigation notes for duplicate billing export files.",
              "Reproduction path: storage write succeeds, DB transaction retries, and the export delivery is created twice.",
              "Fix direction: make the retry boundary idempotent and keep duplicate delivery evidence visible for support and activity review.",
            ),
          },
        ],
        separators: [
          {
            title: "Validated defects",
            list: "Bugs / Issues / Feedback",
            position: "1500",
            color: "red",
            createdBy: "nina",
          },
          {
            title: "Implementation follow-ups",
            list: "In Progress",
            position: "1500",
            color: "blue",
            createdBy: "ben",
          },
          {
            title: "Shipped this cycle",
            list: "Complete",
            position: "1500",
            color: "green",
            createdBy: "priya",
          },
        ],
        cards: [
          {
            title: "Roll out project templates to new workspaces",
            description: note(
              "Onboarding should create a useful engineering workspace in one pass: boards, shared lists, fields, and labels included.",
              "The API payload is the remaining design decision. Validate it against an existing workspace before we let the rollout touch customer data.",
              "A fresh-account check is required because this path only runs when `me.hasWorkspace === false`.",
            ),
            list: "Planning / Review",
            createdBy: "priya",
            assignees: ["priya", "ben"],
            labels: ["Feature / Enhancement"],
            dueOffsetDays: 4,
            dueDateSlot: "afternoon",
            fieldValues: { Branch: "feature/kan-184-workspace-templates", "Billing Hours": 11.5, "Billing Month": seedMonthLabel(), Client: "Sprintforge" },
            attachments: [{ asset: "architectureRecord", uploadedBy: "priya" }],
            checklists: [
              {
                title: "Rollout readiness",
                items: [
                  { text: "Lock template payload shape with API review", assignee: "priya", dueOffsetDays: 1, dueDateSlot: "afternoon", completedBy: "priya", completedOffsetHours: 18 },
                  { text: "Add seeded engineering workspace defaults", assignee: "ben", dueOffsetDays: 2, dueDateSlot: "endOfWorkDay" },
                  { text: "Confirm onboarding still triggers when the user has no workspace", dueOffsetDays: 3, dueDateSlot: "morning" },
                  { text: "Prepare rollback note for workspace bootstrap migration", dueOffsetDays: 4, dueDateSlot: "afternoon" },
                ],
              },
              {
                title: "API and migration",
                items: [
                  { text: "Verify the migration against a populated workspace", dueOffsetDays: 1, dueDateSlot: "morning" },
                  { text: "Confirm list and field positions retain their ordering", dueOffsetDays: 1, dueDateSlot: "afternoon" },
                  { text: "Exercise rollback and reapply locally", dueOffsetDays: 2, dueDateSlot: "morning" },
                  { text: "Review template validation error responses", dueOffsetDays: 2, dueDateSlot: "afternoon" },
                  { text: "Document the final payload example", dueOffsetDays: 3, dueDateSlot: "endOfWorkDay" },
                ],
              },
              {
                title: "Web onboarding",
                items: [
                  { text: "Test the empty-account onboarding route", dueOffsetDays: 1, dueDateSlot: "morning" },
                  { text: "Check template selection on a narrow viewport", dueOffsetDays: 1, dueDateSlot: "afternoon" },
                  { text: "Verify created boards appear without a reload", dueOffsetDays: 2, dueDateSlot: "morning" },
                  { text: "Confirm default custom fields render immediately", dueOffsetDays: 2, dueDateSlot: "afternoon" },
                  { text: "Check keyboard focus after workspace creation", dueOffsetDays: 3, dueDateSlot: "morning" },
                  { text: "Capture the completed onboarding flow", dueOffsetDays: 3, dueDateSlot: "endOfWorkDay" },
                ],
              },
              {
                title: "Release communications",
                items: [
                  { text: "Draft the internal rollout announcement", dueOffsetDays: 2, dueDateSlot: "morning" },
                  { text: "Prepare support troubleshooting notes", dueOffsetDays: 2, dueDateSlot: "afternoon" },
                  { text: "Add the workspace template example to release notes", dueOffsetDays: 3, dueDateSlot: "morning" },
                  { text: "Share the rollback owner and escalation path", dueOffsetDays: 3, dueDateSlot: "afternoon" },
                ],
              },
              {
                title: "Post-release verification",
                items: [
                  { text: "Create a workspace from a fresh owner account", dueOffsetDays: 5, dueDateSlot: "morning" },
                  { text: "Create a workspace from an invited member account", dueOffsetDays: 5, dueDateSlot: "afternoon" },
                  { text: "Confirm every board shares the seeded lists", dueOffsetDays: 6, dueDateSlot: "morning" },
                  { text: "Confirm every board shares the seeded custom fields", dueOffsetDays: 6, dueDateSlot: "afternoon" },
                  { text: "Review onboarding errors in activity history", dueOffsetDays: 7, dueDateSlot: "morning" },
                ],
              },
            ],
            comments: [
              { author: "amelia", hoursAfterCreation: 6, body: "Keep the first release opinionated. We can add template editing once creation is stable." },
              { author: "ben", hoursAfterCreation: 20, body: "I can align the UI copy once the API payload is fixed." },
            ],
          },
          {
            title: "Stabilize billing export retry path",
            description: note(
              "Northstar received the same billing export twice after a storage write succeeded and the database transaction retried.",
              "Reproduce the sequence, make delivery creation idempotent, and leave one clear activity entry for support to reference.",
            ),
            list: "Bugs / Issues / Feedback",
            createdBy: "omar",
            assignees: ["omar", "nina"],
            labels: ["Issue / Bug", "Reporting"],
            dueOffsetDays: -1,
            dueDateSlot: "morning",
            fieldValues: { Branch: "fix/kan-201-export-retry", "Billing Hours": 6, "Billing Month": seedMonthLabel(), Client: "Northstar" },
            attachments: [
              { asset: "billingExportDuplicate", uploadedBy: "nina", useAsCover: true },
              { asset: "apiRolloutPlan", uploadedBy: "omar" },
            ],
            checklists: [
              {
                title: "Regression checks",
                items: [
                  { text: "Reproduce duplicate delivery with storage success and DB retry", dueOffsetDays: -1, dueDateSlot: "morning", completedBy: "nina", completedOffsetHours: 9 },
                  { text: "Make export delivery insert idempotent", dueOffsetDays: 0, dueDateSlot: "afternoon" },
                  { text: "Verify activity history shows the retained delivery once", dueOffsetDays: 1, dueDateSlot: "morning" },
                ],
              },
            ],
            comments: [
              { author: "nina", hoursAfterCreation: 8, body: "I reproduced this with a network throttle against local S3 and against disk storage." },
              { author: "priya", hoursAfterCreation: 15, body: "I want the fix in before the next customer finance review." },
            ],
          },
          {
            title: "Reduce board hydration time for large workspaces",
            description: note(
              "The slow case is a workspace with many labels and custom fields, not an empty board.",
              "Capture before/after timings for the summary payload and make sure opening a card still fetches the full detail when needed.",
            ),
            list: "In Progress",
            createdBy: "ben",
            assignees: ["ben", "priya"],
            labels: ["Feature / Enhancement", "Reporting"],
            dueOffsetDays: 6,
            dueDateSlot: "endOfWorkDay",
            fieldValues: { Branch: "feature/kan-193-board-hydration", "Billing Hours": 13, "Billing Month": seedMonthLabel(), Client: "Orbiflow" },
            comments: [
              { author: "marcus", hoursAfterCreation: 10, body: "If we change the payload shape, capture the before and after timings in the card." },
            ],
          },
          {
            title: "Add push preference controls to mobile settings",
            description: note(
              "Add separate mobile controls for mentions, due dates, and watcher changes.",
              "Keep the setting names aligned with the web notification centre and the support documentation; this is a contract change, not three unrelated toggles.",
            ),
            list: "Backlog",
            createdBy: "marcus",
            assignees: ["ben"],
            labels: ["Feature / Enhancement", "Support"],
            dueOffsetDays: 12,
            dueDateSlot: "afternoon",
            fieldValues: { Branch: "feature/kan-196-mobile-notifications", "Billing Hours": 8.5, "Billing Month": seedMonthLabel(1), Client: "Northstar" },
            comments: [
              { author: "zoe", hoursAfterCreation: 12, body: "Please expose the same settings names we use in help docs so support can point customers to them." },
            ],
          },
          {
            title: "Run QA pass for onboarding with no existing workspaces",
            description: note(
              "Test the empty-account route from both an organisation admin and a normal member account.",
              "The risky part is after creation: shared lists, custom fields, and the first board must appear without a reload.",
            ),
            list: "Ready for QA",
            createdBy: "nina",
            assignees: ["nina"],
            labels: ["Chore"],
            dueOffsetDays: 2,
            dueDateSlot: "morning",
            fieldValues: { Branch: "test/onboarding-no-workspace", "Billing Hours": 4, "Billing Month": seedMonthLabel(), Client: "Sprintforge" },
            checklists: [
              {
                title: "QA matrix",
                items: [
                  { text: "Owner creates first workspace from empty account", dueOffsetDays: 1, dueDateSlot: "morning" },
                  { text: "Member sees onboarding instead of empty board shell", dueOffsetDays: 1, dueDateSlot: "afternoon" },
                  { text: "Default lists and custom fields match workspace seed", dueOffsetDays: 2, dueDateSlot: "morning" },
                  { text: "Mobile viewport lands on created workspace without reload", dueOffsetDays: 2, dueDateSlot: "endOfWorkDay" },
                ],
              },
            ],
            comments: [
              { author: "amelia", hoursAfterCreation: 4, body: "Make sure we test org admins and normal members separately." },
            ],
          },
          {
            title: "Automate changelog draft from shipped activity",
            description: note(
              "Turn the week’s shipped activity into an internal markdown draft for product review.",
              "Keep it deliberately boring for the first pass: title, outcome, and link back to the card.",
            ),
            list: "Wishlist",
            createdBy: "marcus",
            assignees: ["priya"],
            labels: ["Reporting", "Feature / Enhancement"],
            dueOffsetDays: 15,
            fieldValues: { Branch: "spike/changelog-from-activity", "Billing Hours": 3, "Billing Month": seedMonthLabel(1), Client: "Orbiflow" },
            attachments: [{ asset: "retroNotes", uploadedBy: "marcus" }],
          },
          {
            title: "Retry orphaned attachment cleanup on startup",
            description: note(
              "An interrupted upload can leave a file in local or S3 storage before its attachment row exists.",
              "The retry must be conservative: only remove files with no database reference, and keep a dry-run report for maintenance review.",
            ),
            list: "In Progress",
            createdBy: "omar",
            assignees: ["omar", "nina"],
            labels: ["Chore", "Issue / Bug"],
            dueOffsetDays: 3,
            dueDateSlot: "endOfWorkDay",
            fieldValues: { Branch: "fix/orphaned-attachment-cleanup", "Billing Hours": 7.25, "Billing Month": seedMonthLabel(), Client: "Northstar" },
            attachments: [{ asset: "orphanedAttachmentCleanup", uploadedBy: "omar", useAsCover: true }],
            comments: [
              { author: "grace", hoursAfterCreation: 9, body: "Please keep the dry-run output. I want to wire it into our maintenance dashboard later." },
            ],
          },
          {
            title: "Ship SLA metrics widget for customer workspaces",
            description: note(
              "Build the first SLA view from existing due dates and activity instead of creating another analytics store.",
              "The demo needs an honest empty state plus one overdue and one on-time example so the metric is easy to sanity-check.",
            ),
            list: "Awaiting Feedback",
            createdBy: "ben",
            assignees: ["ben", "marcus"],
            labels: ["Reporting"],
            dueOffsetDays: 7,
            dueDateSlot: "afternoon",
            fieldValues: { Branch: "feature/sla-summary-widget", "Billing Hours": 5.5, "Billing Month": seedMonthLabel(), Client: "Sprintforge" },
            comments: [
              { author: "marcus", hoursAfterCreation: 14, body: "I want one example based on overdue cards and one based on on-time completions." },
            ],
          },
          {
            title: "Complete keyboard pass on comment composer",
            description: note(
              "Close the last keyboard traps in the attachment picker and mention menu.",
              "Retest the composer with a screen reader before marking the accessibility milestone complete.",
            ),
            list: "Complete",
            createdBy: "ben",
            assignees: ["ben", "nina"],
            labels: ["Chore"],
            completedBy: "nina",
            completedDaysAgo: 14,
            dueOffsetDays: -4,
            fieldValues: { Branch: "chore/comment-composer-a11y", "Billing Hours": 4.5, "Billing Month": seedMonthLabel(), Client: "Orbiflow" },
            comments: [
              { author: "nina", hoursAfterCreation: 7, body: "Retested with NVDA and VoiceOver. No regressions from the menu focus change." },
            ],
          },
          {
            title: "Refresh engineering branching guide",
            description: note(
              "The branching guide now covers feature, fix, docs, and hotfix branches with the deploy tag examples engineers actually use.",
              "Link the examples to the same branch field shown on delivery cards so the guide and reporting stay in sync.",
            ),
            list: "Complete",
            createdBy: "priya",
            assignees: ["priya"],
            labels: ["Chore"],
            completedBy: "priya",
            completedDaysAgo: 42,
            dueOffsetDays: -6,
            fieldValues: { Branch: "docs/branching-guide-refresh", "Billing Hours": 2, "Billing Month": seedMonthLabel(-1), Client: "Sprintforge" },
            attachments: [{ asset: "onboardingChecklist", uploadedBy: "priya" }],
          },
        ],
      },
      {
        key: "mobile-experience",
        name: "Mobile Experience",
        description: "Release board for the mobile roadmap, polish work, and customer-facing UX improvements.",
        icon: "device-mobile",
        iconColor: "violet",
        createdBy: "marcus",
        notes: [
          {
            title: "Mobile QA Checklist",
            icon: "device-mobile-check",
            owner: "nina",
            content: note(
              "Board-level QA checklist for mobile web and native-style flows.",
              "- Test image, PDF, and DOCX attachment previews\n- Check offline skeleton states before reconnect\n- Confirm due-date reminders keep the card title after a cold start\n- Verify tablet layout does not hide filters or custom fields",
            ),
          },
        ],
        cards: [
          {
            title: "Polish offline card detail skeleton states",
            description: note(
              "On reconnect, the detail panel jumps when an attachment preview or custom-field chip arrives late.",
              "Reserve those regions up front and compare the mobile hierarchy with the current web card detail.",
            ),
            list: "In Progress",
            createdBy: "ben",
            assignees: ["ben"],
            labels: ["Feature / Enhancement"],
            dueOffsetDays: 5,
            dueDateSlot: "morning",
            fieldValues: { Branch: "feature/mobile-offline-skeleton", "Billing Hours": 6.5, "Billing Month": seedMonthLabel(), Client: "Orbiflow" },
            attachments: [{ asset: "offlineCardSkeleton", uploadedBy: "ben", useAsCover: true }],
            checklists: [
              {
                title: "Skeleton coverage",
                items: [
                  { text: "Reserve attachment preview height before reconnect", dueOffsetDays: 2, dueDateSlot: "afternoon", completedBy: "ben", completedOffsetHours: 12 },
                  { text: "Add custom field chip placeholders", dueOffsetDays: 3, dueDateSlot: "morning" },
                  { text: "Retest PDF-first detail panels on iOS Safari", dueOffsetDays: 5, dueDateSlot: "morning" },
                ],
              },
            ],
            comments: [
              { author: "nina", hoursAfterCreation: 16, body: "I still see a layout jump if the first attachment is a PDF rather than an image." },
            ],
          },
          {
            title: "Investigate flaky due-date reminders on iOS",
            description: note(
              "Some iOS reminders arrive after a cold start with the due time but no card title.",
              "Capture the device, timezone, and app state for a reproducible case before changing the notification payload.",
            ),
            list: "Bugs / Issues / Feedback",
            createdBy: "nina",
            assignees: ["nina", "ben"],
            labels: ["Issue / Bug", "Support"],
            dueOffsetDays: 1,
            dueDateSlot: "morning",
            fieldValues: { Branch: "fix/ios-reminder-title", "Billing Hours": 7, "Billing Month": seedMonthLabel(), Client: "Northstar" },
            attachments: [{ asset: "iosReminderMissingTitle", uploadedBy: "nina", useAsCover: true }],
            comments: [
              { author: "amelia", hoursAfterCreation: 5, body: "If the repro depends on a cold start, write that into the test notes so support can help verify." },
            ],
          },
          {
            title: "Prepare tablet layout for board overview",
            description: note(
              "Make the board overview comfortable to demo on an iPad without hiding the member strip or filters.",
              "The first pass only needs the overview shell; card detail and the rest of workspace settings can follow later.",
            ),
            list: "Planning / Review",
            createdBy: "marcus",
            assignees: ["ben", "marcus"],
            labels: ["Feature / Enhancement"],
            dueOffsetDays: 9,
            dueDateSlot: "afternoon",
            fieldValues: { Branch: "feature/tablet-board-overview", "Billing Hours": 9, "Billing Month": seedMonthLabel(), Client: "Orbiflow" },
            attachments: [{ asset: "tabletBoardOverview", uploadedBy: "zoe", useAsCover: true }],
          },
          {
            title: "Backfill biometric auth telemetry",
            description: note(
              "Before adding biometric login, measure how often mobile users hit the re-auth wall and abandon it.",
              "Record only the flow outcome and platform; do not collect biometric data or a device-level identifier.",
            ),
            list: "Backlog",
            createdBy: "amelia",
            assignees: ["priya"],
            labels: ["Reporting", "Feature / Enhancement"],
            dueOffsetDays: 18,
            fieldValues: { Branch: "spike/mobile-auth-telemetry", "Billing Hours": 2.5, "Billing Month": seedMonthLabel(1), Client: "Sprintforge" },
          },
          {
            title: "QA regression pass on card attachments in mobile web",
            description: note(
              "Run the attachment pass on iOS Safari and Chrome for Android: image preview, cover rendering, and PDF handoff.",
              "The Android stretched-preview fix is already in; the iOS result is the remaining demo dependency.",
            ),
            list: "Ready for QA",
            createdBy: "nina",
            assignees: ["nina"],
            labels: ["Chore", "Support"],
            dueOffsetDays: 3,
            dueDateSlot: "endOfWorkDay",
            fieldValues: { Branch: "test/mobile-web-attachments", "Billing Hours": 5, "Billing Month": seedMonthLabel(), Client: "Northstar" },
            attachments: [{ asset: "mobileAttachmentQa", uploadedBy: "nina", useAsCover: true }],
            comments: [
              { author: "ben", hoursAfterCreation: 11, body: "I already fixed the stretched preview issue on Android. The iOS path still needs a pass." },
            ],
          },
          {
            title: "Prototype swipe actions for list cards",
            description: note(
              "Try archive, complete, and reschedule gestures on a list card.",
              "A useful result is either a comfortable interaction or evidence that scrolling and drag-and-drop make this a bad fit for mobile.",
            ),
            list: "Wishlist",
            createdBy: "ben",
            assignees: ["ben"],
            labels: ["Feature / Enhancement"],
            dueOffsetDays: 16,
            fieldValues: { Branch: "spike/mobile-card-swipes", "Billing Hours": 4, "Billing Month": seedMonthLabel(1), Client: "Sprintforge" },
          },
          {
            title: "Follow up on Android font rendering difference",
            description: note(
              "Two Samsung Internet screenshots show label chips clipping when a custom font is enabled.",
              "Compare the computed line height with the default font before adding an Android-only adjustment.",
            ),
            list: "Awaiting Feedback",
            createdBy: "zoe",
            assignees: ["ben", "nina"],
            labels: ["Issue / Bug", "Support"],
            dueOffsetDays: 8,
            dueDateSlot: "afternoon",
            fieldValues: { Branch: "fix/android-chip-line-height", "Billing Hours": 3.5, "Billing Month": seedMonthLabel(), Client: "Orbiflow" },
            attachments: [{ asset: "androidLabelClipping", uploadedBy: "zoe", useAsCover: true }],
            comments: [
              { author: "zoe", hoursAfterCreation: 7, body: "This shows up in screenshots from two customers using Samsung Internet." },
            ],
          },
          {
            title: "Ship mobile build info footer to settings",
            description: note(
              "Support can now find the mobile build number, API environment, and short commit SHA in Settings.",
              "The values come from the shared build-info model, so a support screenshot identifies the app without exposing secrets.",
            ),
            list: "Complete",
            createdBy: "priya",
            assignees: ["priya"],
            labels: ["Chore", "Support"],
            completedBy: "priya",
            completedDaysAgo: 63,
            dueOffsetDays: -2,
            fieldValues: { Branch: "feature/mobile-build-info", "Billing Hours": 2.5, "Billing Month": seedMonthLabel(-2), Client: "Sprintforge" },
          },
          {
            title: "Tighten upload progress copy for slow connections",
            description: note(
              "Replace the failure-sounding upload message with copy that explains when a large image or document is still transferring.",
              "The same wording should work for slow mobile connections and support replies.",
            ),
            list: "In Progress",
            createdBy: "zoe",
            assignees: ["omar", "ben"],
            labels: ["Support", "Chore"],
            dueOffsetDays: 4,
            fieldValues: { Branch: "copy/mobile-upload-progress", "Billing Hours": 1.5, "Billing Month": seedMonthLabel(), Client: "Northstar" },
            comments: [
              { author: "marcus", hoursAfterCreation: 6, body: "Keep the language operational, not playful. Support wants something they can repeat to customers." },
            ],
          },
          {
            title: "Document push notification troubleshooting flow",
            description: note(
              "The support playbook now covers token refresh, permission reset, and stale badge counts.",
              "It is the temporary path for the beta inbox until customers can repair notification settings themselves.",
            ),
            list: "Complete",
            createdBy: "grace",
            assignees: ["omar", "nina"],
            labels: ["Chore"],
            completedBy: "grace",
            completedDaysAgo: 91,
            dueOffsetDays: -7,
            fieldValues: { Branch: "docs/mobile-push-troubleshooting", "Billing Hours": 2, "Billing Month": seedMonthLabel(-3), Client: "Orbiflow" },
            attachments: [{ asset: "onboardingChecklist", uploadedBy: "grace" }],
          },
        ],
      },
    ],
  };
}

function buildMarketingWorkspace(): SeedWorkspace {
  // Reuse the existing demo identities as the marketing cast: Amelia is the director, Ben is
  // the campaign manager, then Nina/Zoe/Leo/Omar/Grace cover creative/content/web/events/coordination.
  type MarketingCardSeed = {
    title: string;
    assignee: SeedUserKey;
    description: readonly string[];
    createdBy?: SeedUserKey;
    createdDaysAgo?: number;
    dueOffsetDays?: number;
    dueDateSlot?: CardDueDateSlot;
    labels?: string[];
    fieldValues?: Record<string, SeedFieldValue>;
    attachments?: SeedAttachment[];
    checklists?: SeedChecklist[];
    comments?: SeedComment[];
    watchers?: SeedUserKey[];
  };

  type MarketingCardGroup = {
    list: string;
    cards: readonly MarketingCardSeed[];
  };

  const fieldValuesForMarketingCard = (
    title: string,
    list: string,
  ): Record<string, SeedFieldValue> | undefined => {
    const values: Record<string, SeedFieldValue> = {};
    const value = title.toLowerCase();

    if (value.includes("recruitment")) values.Campaign = "Recruitment campaign";
    else if (value.includes("northshore")) values.Campaign = "Northshore customer story";
    else if (value.includes("autumn") || value.includes("campaign")) values.Campaign = "Autumn launch";
    else if (value.includes("webinar")) values.Campaign = "Webinar programme";

    const budgetByTitle: Record<string, number> = {
      "Approve campaign budget": 28_000,
      "Design campaign graphics": 6_800,
      "Organise autumn customer webinar": 8_500,
      "Sponsor regional industry event": 12_000,
      "Update recruitment brochure": 2_400,
    };
    if (budgetByTitle[title] !== undefined) values.Budget = budgetByTitle[title];

    if (list === "Review & Approval") values.Approved = false;
    if (list === "Done") values.Approved = true;

    return Object.keys(values).length > 0 ? values : undefined;
  };

  // Labels describe the kind of work, not the board it happens to live on. This keeps filters
  // useful across the workspace and leaves general coordination cards intentionally unlabelled.
  const labelsForMarketingCard = (title: string): string[] => {
    const value = title.toLowerCase();
    const labels: string[] = [];
    const addWhen = (pattern: RegExp, label: string) => {
      if (pattern.test(value)) labels.push(label);
    };

    addWhen(/\b(campaign|launch|promotion)\b/, "Campaign");
    addWhen(/\b(design|graphic|illustration|photography|logo|icon|visual|asset|template|document cover|brochure)\w*\b/, "Design");
    addWhen(/\b(copy|content|article|story|interview|newsletter|quotation|testimonial|messag|wording|headline|tone|research)\w*\b/, "Copy & Content");
    addWhen(/\b(email|newsletter)\w*\b/, "Email");
    addWhen(/\b(social|behind-the-scenes)\b/, "Social");
    addWhen(/\b(website|web page|homepage|landing[- ]page|privacy-page|registration page|partner directory|careers page|resources (section|page)|broken links|accessibility|interactive campaign page)\b/, "Web");
    addWhen(/\b(analytics|measurement|data|report|audience)\w*\b/, "Analytics");
    addWhen(/\b(event|webinar|conference|roundtable|speaker|venue|training session)\w*\b/, "Events");
    addWhen(/\b(partner|partnership)\w*\b/, "Partner");
    addWhen(/\b(sales|recruitment|hr|finance|leadership|departmental)\b/, "Internal Request");
    if (title === "Confirm product messaging") labels.push("Blocked");

    return labels;
  };

  const buildMarketingCards = (
    groups: readonly MarketingCardGroup[],
  ): SeedCard[] => groups.flatMap((group) => group.cards.map((card, index) => {
    const { title, assignee } = card;
    const isDone = group.list === "Done";
    const isHero = title === "Prepare autumn campaign launch";
    const inferredFields = fieldValuesForMarketingCard(title, group.list);
    const fieldValues = inferredFields || card.fieldValues
      ? { ...inferredFields, ...card.fieldValues }
      : undefined;

    return {
      title,
      description: note(...card.description),
      list: group.list,
      createdBy: card.createdBy ?? (group.list === "Ideas & Requests" ? "grace" : assignee),
      assignees: [assignee],
      labels: card.labels ?? labelsForMarketingCard(title),
      dueOffsetDays: card.dueOffsetDays,
      dueDateSlot: card.dueDateSlot,
      fieldValues,
      attachments: card.attachments,
      checklists: card.checklists,
      comments: card.comments,
      watchers: card.watchers,
      createdDaysAgo: card.createdDaysAgo ?? (isDone ? 18 + index * 3 : 4 + index),
      ...(isDone ? { completedBy: assignee, completedDaysAgo: 3 + index * 2 } : {}),
      ...(isHero ? {
        description: note(
          "Coordinate the final preparation for the autumn campaign launch across creative, content, web, email, social, and partner activity.",
          "The launch is waiting on final product messaging. Once it lands, Ben will run the final approval pass with Amelia and publish Grace's hour-by-hour launch schedule.",
          "Use this as the single readiness view; channel-specific production stays on the linked web, content, creative, and events boards.",
        ),
        watchers: ["amelia", "zoe", "leo", "omar", "grace"] as SeedUserKey[],
        attachments: [{ asset: "campaignLaunchReadiness" as const, uploadedBy: "ben" as const, useAsCover: true }],
        checklists: [{
          title: "Launch readiness",
          items: [
            { text: "Confirm final product messaging" },
            { text: "Approve campaign graphics", completedBy: "amelia" as const, completedOffsetHours: 8 },
            { text: "Verify landing-page tracking", completedBy: "leo" as const, completedOffsetHours: 12 },
            { text: "Publish the launch-day schedule" },
          ],
        }],
        comments: [
          {
            author: "amelia" as const,
            hoursAfterCreation: 8,
            body: "Creative is approved. Ben, keep this card as the single launch-readiness view and update it as soon as product messaging lands.",
            mentions: ["ben" as const],
          },
          {
            author: "ben" as const,
            hoursAfterCreation: 18,
            body: "The landing-page draft and email copy are in review. I am holding the final schedule until product confirms the headline wording.",
            mentions: ["amelia" as const, "grace" as const],
            unreadFor: ["amelia" as const],
          },
        ],
      } : {}),
    };
  }));

  const autumnCampaignCards = buildMarketingCards([
    {
      list: "Ideas & Requests",
      cards: [
        {
          title: "Explore a customer referral offer",
          assignee: "ben",
          description: [
            "Customers already recommend Kanera informally; explore whether a small double-sided referral offer would create qualified introductions.",
          ],
          createdBy: "amelia",
          comments: [{ author: "amelia", hoursAfterCreation: 5, body: "Please keep this deliberately small. I am more interested in qualified introductions than a high-volume discount code.", mentions: ["ben"] }],
        },
        {
          title: "Behind-the-scenes launch diary",
          assignee: "zoe",
          description: [
            "Sketch three useful, behind-the-scenes launch diary episodes before anyone commits production time.",
          ],
          createdBy: "grace",
        },
        {
          title: "Add a pre-launch countdown teaser",
          assignee: "zoe",
          description: [
            "Test a three-email countdown for the campaign audience; the first message needs a concrete reason to open the second.",
          ],
          createdBy: "grace",
        },
        {
          title: "Explore a launch-week partner content swap",
          assignee: "omar",
          description: [
            "Orbiflow offered a reciprocal launch-week newsletter mention. Check audience overlap and agree wording before either team promises a slot.",
          ],
        },
      ],
    },
    {
      list: "Ready to Start",
      cards: [
        {
          title: "Lock the autumn campaign brief",
          assignee: "ben",
          description: [
            "The brief is ready apart from the final product promise; insert it, publish version 1.0, and archive the workshop draft.",
          ],
          dueOffsetDays: 2,
          watchers: ["amelia", "zoe", "nina"],
          checklists: [{
            title: "Brief sign-off",
            items: [
              { text: "Insert final product promise" },
              { text: "Confirm audience exclusions", completedBy: "amelia", completedOffsetHours: 6 },
              { text: "Link approved customer proof", completedBy: "zoe", completedOffsetHours: 11 },
              { text: "Publish version 1.0 to the team" },
            ],
          }],
        },
        {
          title: "Build the launch measurement sheet",
          assignee: "leo",
          description: [
            "Bring landing conversion, email engagement, partner referrals, and demo requests into one launch view with last quarter as the baseline.",
          ],
          createdBy: "ben",
          labels: ["Campaign", "Analytics"],
        },
      ],
    },
    {
      list: "In Progress",
      cards: [
        {
          title: "Design the autumn campaign graphics",
          assignee: "nina",
          description: [
            "Finish the warm editorial route: landing hero, email header, social crops, and partner lockup.",
            "Keep product UI out of the artwork; Leo is supplying screenshots as separate campaign assets.",
          ],
          dueOffsetDays: 3,
          attachments: [{ asset: "campaignReviewCover", uploadedBy: "nina", useAsCover: true }],
          checklists: [{
            title: "Required exports",
            items: [
              { text: "Landing-page hero at desktop and mobile sizes", completedBy: "nina", completedOffsetHours: 10 },
              { text: "Email header with dark-mode check" },
              { text: "Three social crops with safe areas" },
              { text: "Partner lockup without the launch date" },
            ],
          }],
          comments: [
            { author: "zoe", hoursAfterCreation: 9, body: "Concept two gives the headline enough room. Can we keep the paper texture on social but remove it behind the email copy?", mentions: ["nina"] },
            { author: "nina", hoursAfterCreation: 20, body: "Yes. I have split the texture into a separate layer and will add a clean email export in the next review set.", mentions: ["zoe"] },
          ],
        },
        {
          title: "Write the campaign landing-page copy",
          assignee: "zoe",
          description: [
            "Write the landing page from the approved outline, then replace the temporary headline without reopening the supporting sections.",
          ],
          dueOffsetDays: 2,
          createdBy: "ben",
          comments: [{ author: "ben", hoursAfterCreation: 12, body: "The customer proof section is strong. Please cut the second workflow example and use that space to answer the migration objection.", mentions: ["zoe"], unreadFor: ["zoe"] }],
        },
        {
          title: "Prepare the launch-week social schedule",
          assignee: "grace",
          description: [
            "Map the announcement, customer proof, walkthrough, and partner posts across launch week, leaving two slots for reactive work.",
          ],
          createdBy: "ben",
          checklists: [{
            title: "Schedule coverage",
            items: [
              { text: "Draft launch-day posts", completedBy: "grace", completedOffsetHours: 7 },
              { text: "Add customer-story follow-up" },
              { text: "Confirm partner posting windows" },
              { text: "Assign launch-day replies" },
            ],
          }],
        },
        {
          title: "Produce the launch-day explainer video",
          assignee: "nina",
          description: [
            "Cut a 60-second story around one shared-workspace example, not a feature tour.",
            "Record against the stable preview build and keep the voiceover aligned with the approved landing page.",
          ],
          dueOffsetDays: 4,
          createdBy: "ben",
          checklists: [{
            title: "Video production",
            items: [
              { text: "Storyboard from the approved script", completedBy: "nina", completedOffsetHours: 6 },
              { text: "Record screen capture on the launch build" },
              { text: "Add captions and dark-mode-safe titles" },
              { text: "Export square and landscape cuts" },
            ],
          }],
          comments: [{ author: "leo", hoursAfterCreation: 13, body: "The launch build will be stable on the preview URL from Thursday. Record after that so the footage matches the live landing page.", mentions: ["nina"] }],
        },
        {
          title: "Finalise the campaign tracking and UTM plan",
          assignee: "leo",
          description: [
            "Publish the UTM and event naming convention before launch so email clicks, landing conversions, and partner referrals reconcile on day one.",
          ],
          createdBy: "ben",
          labels: ["Campaign", "Analytics"],
        },
      ],
    },
    {
      list: "Review & Approval",
      cards: [
        {
          title: "Approve the campaign launch package",
          assignee: "amelia",
          description: [
            "Review the launch package as one customer experience: promise, proof, design, CTA, and partner language should agree across channels.",
          ],
          createdBy: "ben",
          dueOffsetDays: 4,
          watchers: ["ben", "nina", "zoe"],
        },
        {
          title: "Approve the customer announcement email",
          assignee: "amelia",
          description: [
            "Choose between Zoe’s two subject lines, check the opening on mobile, and confirm audience exclusions before scheduling.",
          ],
          createdBy: "zoe",
          comments: [{ author: "zoe", hoursAfterCreation: 6, body: "I prefer subject line B; it is less clever, but the benefit is obvious on mobile. Both variants are linked in the first comment.", mentions: ["amelia"] }],
        },
      ],
    },
    {
      list: "Waiting on Others",
      cards: [
        {
          title: "Prepare autumn campaign launch",
          assignee: "ben",
          description: ["Coordinate the final launch checklist across approved creative, copy, web, email, social, and partner work."],
          createdBy: "amelia",
          dueOffsetDays: 5,
        },
        {
          title: "Confirm final product messaging",
          assignee: "ben",
          description: [
            "Blocked on Product choosing the launch promise: cross-board consistency or faster campaign coordination. Ben will update the dependent assets once decided.",
          ],
          createdBy: "zoe",
          dueOffsetDays: -1,
          labels: ["Campaign", "Copy & Content", "Blocked"],
          comments: [{ author: "ben", hoursAfterCreation: 10, body: "I sent the two-line recommendation to Priya. If we do not have an answer by tomorrow morning, I will use the coordination version for the review build.", mentions: ["amelia"] }],
        },
        {
          title: "Receive the partner media quotation",
          assignee: "omar",
          description: [
            "Waiting for Orbiflow’s rate card, placement size, and cancellation terms before creative work starts.",
          ],
          createdBy: "ben",
        },
      ],
    },
    {
      list: "Done",
      cards: [
        {
          title: "Campaign audience agreed",
          assignee: "ben",
          description: [
            "Launch audience: operations leaders at growing service businesses. Existing customers will receive a separate product update.",
          ],
          createdBy: "amelia",
          createdDaysAgo: 24,
        },
        {
          title: "Customer research synthesis shared",
          assignee: "zoe",
          description: [
            "Eight customer calls are distilled into three recurring problems and five approved phrases for the campaign team to quote.",
          ],
          createdBy: "ben",
          createdDaysAgo: 20,
          comments: [{ author: "amelia", hoursAfterCreation: 22, body: "This is exactly the level of detail the creative team needed. The phrase about rebuilding context every Monday should anchor the campaign.", mentions: ["zoe"] }],
        },
        {
          title: "Launch date locked across teams",
          assignee: "ben",
          description: [
            "Creative, content, web, events, and partner owners are working to one launch date with a two-day change freeze.",
          ],
          createdBy: "amelia",
        },
        {
          title: "Competitive messaging scan completed",
          assignee: "zoe",
          description: [
            "The scan covered three adjacent tools and removed two claims competitors already own more credibly.",
          ],
          createdBy: "ben",
        },
        {
          title: "Creative concept directions presented",
          assignee: "nina",
          description: [
            "Three launch directions were presented; the warm editorial route won and the other two are archived with the decision rationale.",
          ],
          createdBy: "amelia",
          comments: [{ author: "amelia", hoursAfterCreation: 20, body: "Good call keeping the archived directions visible. When sales asks why we did not go bolder, we can point to the reasoning instead of relitigating it.", mentions: ["nina"] }],
        },
      ],
    },
  ]);

  const brandRefreshCards = buildMarketingCards([
    {
      list: "Ideas & Requests",
      cards: [
        {
          title: "Explore a warmer illustration style",
          assignee: "nina",
          description: [
            "Collect references for a warmer editorial illustration style; this is exploration, not a request for finished artwork.",
          ],
          createdBy: "amelia",
        },
        {
          title: "Create a small customer icon family",
          assignee: "nina",
          description: [
            "Sketch six simple industry icons for customer stories and test them at card-thumbnail size before expanding the set.",
          ],
          createdBy: "zoe",
        },
        {
          title: "Refresh the presentation icon set",
          assignee: "nina",
          description: [
            "Replace the three mixed icon styles in the sales deck with a focused set for the twenty concepts reps actually use.",
          ],
          createdBy: "grace",
        },
        {
          title: "Define a light motion guideline",
          assignee: "nina",
          description: [
            "Document sensible durations, easing, and reduced-motion rules for loading states, reveals, and product GIFs.",
          ],
          createdBy: "amelia",
        },
        {
          title: "Plan a shot list for the next office visit",
          assignee: "grace",
          description: [
            "Make the next office shoot useful: list the team, candid, and workspace shots needed for brand refresh and recruitment before booking the day.",
          ],
          createdBy: "nina",
        },
      ],
    },
    {
      list: "Ready to Start",
      cards: [
        {
          title: "Consolidate brand colours into design tokens",
          assignee: "leo",
          description: [
            "Turn the approved colour roles into shared tokens for the website, email, and product; agree names before implementation starts.",
          ],
          createdBy: "nina",
          labels: ["Design", "Web"],
        },
        {
          title: "Audit the remaining brand assets",
          assignee: "grace",
          description: [
            "Finish the inventory of sales, event, social, document, and partner assets still using the old visual system.",
            "Each item needs one decision—retire, migrate, or leave alone—and an owner if it is customer-facing.",
          ],
          createdBy: "nina",
          checklists: [{
            title: "Asset locations",
            items: [
              { text: "Sales and customer-success shared drives", completedBy: "grace", completedOffsetHours: 8 },
              { text: "Event and webinar folders" },
              { text: "Website download library" },
              { text: "Partner enablement kit" },
            ],
          }],
        },
        {
          title: "Collect departmental brand requests",
          assignee: "grace",
          description: [
            "Ask Sales, Customer Success, and Recruitment for real examples and frequency of use, then group the requests into reusable templates.",
          ],
          createdBy: "amelia",
        },
      ],
    },
    {
      list: "In Progress",
      cards: [
        {
          title: "Update the sales presentation template",
          assignee: "nina",
          description: [
            "Rebuild the core sales deck with the refreshed type, colour, image, and proof-point system.",
            "Keep a short first-call version and a longer procurement path without shrinking the type to fit.",
          ],
          createdBy: "grace",
          dueOffsetDays: 7,
          comments: [{ author: "grace", hoursAfterCreation: 14, body: "Sales uses the comparison slide in almost every call. Please keep a version with three columns even if it is not the prettiest layout.", mentions: ["nina"] }],
        },
        {
          title: "Build the social template kit",
          assignee: "nina",
          description: [
            "Create reusable square and portrait layouts for announcements, customer quotes, events, product tips, and simple data points.",
            "Test each template with long, awkward copy before handing it to non-designers.",
          ],
          createdBy: "grace",
          checklists: [{
            title: "Template set",
            items: [
              { text: "Announcement and release", completedBy: "nina", completedOffsetHours: 6 },
              { text: "Customer quotation", completedBy: "nina", completedOffsetHours: 15 },
              { text: "Event promotion" },
              { text: "Product tip and data point" },
              { text: "Usage notes for non-designers" },
            ],
          }],
          comments: [{ author: "zoe", hoursAfterCreation: 18, body: "I added a deliberately long customer quote to the working file. It breaks the current portrait layout at about 190 characters.", mentions: ["nina"] }],
        },
        {
          title: "Rewrite the brand voice examples",
          assignee: "zoe",
          description: [
            "Replace abstract tone words with before-and-after examples from emails, web pages, product updates, and support content.",
            "Include a more direct register for incidents and billing; the brand should not sound cheerful in every situation.",
          ],
          createdBy: "amelia",
        },
      ],
    },
    {
      list: "Review & Approval",
      cards: [
        {
          title: "Review the updated colour guidance",
          assignee: "amelia",
          description: [
            "Review the proposed colour roles and accessible pairings, especially where the accent palette overwhelms the page.",
          ],
          createdBy: "nina",
          comments: [{ author: "leo", hoursAfterCreation: 9, body: "All documented text/background pairs pass AA. I flagged two chart combinations that become indistinguishable in common colour-vision simulations.", mentions: ["nina", "amelia"] }],
        },
        {
          title: "Approve the revised voice guidance",
          assignee: "amelia",
          description: [
            "Approve the principles and worked examples replacing the old “clear, human, bold” one-pager.",
            "Legal’s claims examples can remain a follow-up; the everyday product and campaign language is ready to decide.",
          ],
          createdBy: "zoe",
          dueOffsetDays: 6,
        },
      ],
    },
    {
      list: "Waiting on Others",
      cards: [
        {
          title: "Legal review of brand claims wording",
          assignee: "zoe",
          description: [
            "Legal is reviewing six outcome-claim examples. Four are cleared; two still need safer wording than “eliminates admin.”",
          ],
          createdBy: "amelia",
          comments: [{ author: "zoe", hoursAfterCreation: 20, body: "Four examples are cleared. The two remaining questions both use the phrase 'eliminates admin', so I have drafted a less absolute fallback.", mentions: ["amelia"] }],
        },
        {
          title: "Receive the final photography licence",
          assignee: "nina",
          description: [
            "The crop and colour treatment are approved, but web and event usage still await the countersigned licence.",
          ],
          createdBy: "grace",
          dueOffsetDays: 4,
        },
      ],
    },
    {
      list: "Done",
      cards: [
        {
          title: "Logo usage guide updated",
          assignee: "nina",
          description: [
            "The guide covers minimum size, clear space, partner lockups, single-colour use, and when to use the white mark.",
          ],
          createdBy: "amelia",
          createdDaysAgo: 27,
        },
        {
          title: "Legacy templates archived",
          assignee: "grace",
          description: [
            "Obsolete deck, document, and social templates now point to an archive notice; new work starts from the refreshed system.",
          ],
          createdBy: "nina",
          createdDaysAgo: 16,
        },
        {
          title: "Brand type scale finalised",
          assignee: "nina",
          description: [
            "The refreshed type scale is documented for headings, body copy, and dense UI text, including the longest real customer name and smallest card label.",
          ],
          createdBy: "amelia",
        },
        {
          title: "Primary typeface licence renewed",
          assignee: "grace",
          description: [
            "Web and desktop typeface licences are renewed, with seats reconciled and PDF embedding coverage recorded for the next renewal.",
          ],
          createdBy: "amelia",
        },
        {
          title: "Brand principles one-pager published",
          assignee: "zoe",
          description: [
            "The new one-pager gives each brand principle one example and one boundary, then links to the fuller voice and colour guidance.",
          ],
          createdBy: "nina",
        },
        {
          title: "Refresh kickoff workshop held",
          assignee: "nina",
          description: [
            "Kickoff decisions cover scope, non-negotiables, and what is explicitly out for this round; new requests can now be checked against them.",
          ],
          createdBy: "amelia",
          createdDaysAgo: 40,
        },
      ],
    },
  ]);

  const websiteCards = buildMarketingCards([
    {
      list: "Ideas & Requests",
      cards: [
        {
          title: "Create an operations industry page",
          assignee: "leo",
          description: [
            "Test whether one operations-focused page can reuse existing proof and attract enough qualified traffic to justify its upkeep.",
          ],
          createdBy: "ben",
        },
        {
          title: "Add a browsable partner directory",
          assignee: "omar",
          description: [
            "Define the smallest partner directory that can verify integrations without creating a second stale sales database.",
            "Set an owner for each listing and a removal rule for inactive partners before Leo estimates the build.",
          ],
          createdBy: "grace",
          comments: [{ author: "leo", hoursAfterCreation: 16, body: "Please include who owns the source data. The build is straightforward; stale partner status is the part that could make this expensive.", mentions: ["omar"] }],
        },
        {
          title: "Add a status page link to the site footer",
          assignee: "leo",
          description: [
            "Security reviewers keep asking for the public status page. Add it to the footer after DevOps confirms the exposed URL.",
          ],
          createdBy: "grace",
        },
      ],
    },
    {
      list: "Ready to Start",
      cards: [
        {
          title: "Improve the pricing-page FAQ",
          assignee: "zoe",
          description: [
            "Rewrite the pricing FAQ around the three billing and rollout questions reps hear after every page visit; remove the two reassurance-only entries.",
          ],
          createdBy: "ben",
        },
        {
          title: "Compress and lazy-load marketing-site imagery",
          assignee: "leo",
          description: [
            "Compress the largest marketing images and lazy-load below-the-fold artwork; the hero must continue to paint immediately on mobile.",
          ],
          createdBy: "leo",
          labels: ["Web", "Analytics"],
        },
        {
          title: "Define the homepage update scope",
          assignee: "ben",
          description: [
            "Bound the homepage update to hero, proof order, primary CTA, and the first product section.",
            "Navigation and pricing findings belong in separate follow-ups so the autumn launch does not become a site-wide redesign.",
          ],
          createdBy: "amelia",
          checklists: [{
            title: "Scope decisions",
            items: [
              { text: "Agree the primary homepage audience", completedBy: "ben", completedOffsetHours: 4 },
              { text: "Choose the lead customer proof" },
              { text: "Confirm sections explicitly out of scope", completedBy: "amelia", completedOffsetHours: 9 },
              { text: "Write the measurement hypothesis" },
            ],
          }],
        },
        {
          title: "Gather approved homepage testimonials",
          assignee: "grace",
          description: [
            "Shortlist concise, traceable customer quotations for the new homepage promise; mark anything needing fresh legal approval as fallback only.",
          ],
          createdBy: "zoe",
        },
      ],
    },
    {
      list: "In Progress",
      cards: [
        {
          title: "Build the autumn campaign landing page",
          assignee: "leo",
          description: [
            "Implement Zoe’s approved campaign structure with responsive artwork, persistent campaign source, accessible form errors, and a no-quotation fallback.",
          ],
          dueOffsetDays: 3,
          createdBy: "ben",
          checklists: [{
            title: "Build and QA",
            items: [
              { text: "Implement responsive page sections", completedBy: "leo", completedOffsetHours: 8 },
              { text: "Wire campaign-source tracking", completedBy: "leo", completedOffsetHours: 14 },
              { text: "Add no-quotation fallback" },
              { text: "Test form errors with keyboard only" },
              { text: "Run final mobile visual check" },
            ],
          }],
          comments: [
            { author: "leo", hoursAfterCreation: 12, body: "The page is on the preview URL. Tracking persists through the demo-request form; I am still fixing the mobile crop on Nina's hero artwork.", mentions: ["nina", "ben"] },
            { author: "nina", hoursAfterCreation: 19, body: "I uploaded a 4:5 crop with extra space above the subject. That should remove the awkward focal-point shift below 420px.", mentions: ["leo"] },
          ],
        },
        {
          title: "Rewrite the homepage headline",
          assignee: "zoe",
          description: [
            "Bring three genuinely different homepage headline routes, each paired with evidence that makes the shared-workspace promise credible.",
          ],
          createdBy: "ben",
          comments: [{ author: "amelia", hoursAfterCreation: 11, body: "Route one is closest, but 'one operating system' sounds larger than the evidence supports. Keep the idea of shared structure and make the claim more literal.", mentions: ["zoe"] }],
        },
        {
          title: "Update the customer-story page layout",
          assignee: "leo",
          description: [
            "Make results, customer context, and quotations easier to scan without forcing every story into one rigid template.",
            "Use Northshore as the stress test, including the no-metrics and no-photography states.",
          ],
          createdBy: "zoe",
        },
        {
          title: "Rebuild the mobile navigation",
          assignee: "leo",
          description: [
            "The mobile menu hides the demo CTA behind two taps. Keep that action visible and make open, close, and focus behaviour screen-reader safe.",
          ],
          dueOffsetDays: 6,
          createdBy: "ben",
          checklists: [{
            title: "Navigation rebuild",
            items: [
              { text: "Prototype the collapsed menu with the CTA pinned", completedBy: "leo", completedOffsetHours: 9 },
              { text: "Wire keyboard focus trapping and escape" },
              { text: "Screen-reader pass on open and close" },
              { text: "Check tap targets against the mobile guidelines" },
            ],
          }],
        },
        {
          title: "Write the operations industry page copy",
          assignee: "zoe",
          description: [
            "Lead with the tracker and handoff problems operations leads describe in sales calls, then introduce the product framing and existing proof.",
          ],
          createdBy: "ben",
        },
      ],
    },
    {
      list: "Review & Approval",
      cards: [
        {
          title: "Review the campaign landing page",
          assignee: "ben",
          description: [
            "Review message order, CTA clarity, proof, and the handoff into the demo-request form against the campaign brief.",
          ],
          createdBy: "leo",
          dueOffsetDays: 4,
          watchers: ["zoe", "nina"],
        },
        {
          title: "Complete the landing-page accessibility pass",
          assignee: "leo",
          description: [
            "Run the final accessibility pass with production content: headings, keyboard order, focus, form errors, contrast, reduced motion, and CTA meaning.",
          ],
          createdBy: "ben",
          labels: ["Web"],
          checklists: [{
            title: "Accessibility review",
            items: [
              { text: "Automated scan with final content", completedBy: "leo", completedOffsetHours: 5 },
              { text: "Keyboard and visible-focus pass" },
              { text: "Screen-reader form-error check" },
              { text: "Reduced-motion and zoom check" },
            ],
          }],
        },
      ],
    },
    {
      list: "Waiting on Others",
      cards: [
        {
          title: "Customer approval for homepage quotation",
          assignee: "grace",
          description: [
            "Northshore approved the interview but not the shortened homepage quote. Keep the Orbiflow fallback in the build until written approval arrives.",
          ],
          createdBy: "zoe",
          dueOffsetDays: 2,
          comments: [{ author: "grace", hoursAfterCreation: 18, body: "Their customer lead is comfortable with the edit and has sent it to legal. I have moved the fallback quote into the build so we are not blocked.", mentions: ["leo", "zoe"] }],
        },
        {
          title: "Legal review of the privacy-page update",
          assignee: "leo",
          description: [
            "Legal is reviewing the short paragraph explaining campaign-source tracking; retention and the underlying policy are unchanged.",
          ],
          createdBy: "grace",
        },
      ],
    },
    {
      list: "Done",
      cards: [
        {
          title: "Website content audit completed",
          assignee: "zoe",
          description: [
            "Every public page now has an owner, review date, audience, and keep/revise/merge/retire decision.",
          ],
          createdBy: "ben",
          createdDaysAgo: 30,
        },
        {
          title: "Marketing analytics dashboard configured",
          assignee: "leo",
          description: [
            "The dashboard separates anonymous traffic, campaign sessions, form starts, qualified requests, and customer-only visits.",
            "Filters and launch annotations are documented so the Monday review can distinguish a campaign effect from an outage.",
          ],
          createdBy: "amelia",
          createdDaysAgo: 22,
          comments: [{ author: "ben", hoursAfterCreation: 23, body: "The form-start to qualified-request view already answered a question we have argued about for months. I added the dashboard to the Monday review note.", mentions: ["leo"] }],
        },
        {
          title: "Broken-link sweep completed",
          assignee: "leo",
          description: [
            "The site crawl fixed thirty-one broken links, mostly retired posts and moved help-centre pages; the check now runs monthly.",
          ],
          createdBy: "grace",
        },
        {
          title: "Cookie-consent banner updated",
          assignee: "leo",
          description: [
            "The banner matches the current tags, waits before loading non-essential scripts, and remembers the choice across marketing and login.",
          ],
          createdBy: "grace",
          createdDaysAgo: 26,
        },
      ],
    },
  ]);

  const contentCards = buildMarketingCards([
    {
      list: "Ideas & Requests",
      cards: [
        {
          title: "Annual operations trends article",
          assignee: "zoe",
          description: [
            "Test whether a research-led piece on small operations teams standardising client work has a claim we can credibly own.",
          ],
          createdBy: "amelia",
          attachments: [{ asset: "contentOperationsTrendsResearch", uploadedBy: "zoe", useAsCover: true }],
        },
        {
          title: "Customer interview mini-series",
          assignee: "ben",
          description: [
            "Explore a customer interview format centred on one changed operating habit, not a full company profile; do not promise a monthly cadence before two recordings.",
          ],
          createdBy: "zoe",
          attachments: [{ asset: "contentCustomerInterviewRecording", uploadedBy: "ben", useAsCover: true }],
        },
        {
          title: "Repurpose the Northshore story into a short video",
          assignee: "zoe",
          description: [
            "After text approval and separate video consent, cut the Northshore story into a two-minute version using only verified numbers.",
          ],
          createdBy: "grace",
        },
        {
          title: "Trial a monthly 'how we work' note",
          assignee: "ben",
          description: [
            "Draft two customer-facing notes about a specific change in how the team works before committing to a monthly cadence.",
          ],
          createdBy: "amelia",
        },
      ],
    },
    {
      list: "Ready to Start",
      cards: [
        {
          title: "Outline the operations benchmark report",
          assignee: "zoe",
          description: [
            "Prepare the report structure and chart list now; leave every number blank until the research partner’s weighted data and methodology arrive.",
          ],
          createdBy: "ben",
        },
        {
          title: "Prepare the Northshore customer interview",
          assignee: "ben",
          description: [
            "Prepare a 45-minute conversation about Northshore’s move from departmental trackers to one shared workflow.",
            "Add adoption and measurable-change follow-ups, then send recording consent before the call.",
          ],
          dueOffsetDays: 5,
          createdBy: "zoe",
          attachments: [{ asset: "contentInterviewPreparation", uploadedBy: "ben", useAsCover: true }],
          checklists: [{
            title: "Interview preparation",
            items: [
              { text: "Review account timeline with customer success", completedBy: "ben", completedOffsetHours: 7 },
              { text: "Tailor approved question set" },
              { text: "Send recording and quotation consent" },
              { text: "Prepare a no-metrics fallback angle" },
            ],
          }],
        },
        {
          title: "Draft next quarter's content calendar",
          assignee: "zoe",
          description: [
            "Turn campaign, customer-story, product, and event commitments into a twelve-week plan with protected reactive capacity.",
          ],
          createdBy: "ben",
          attachments: [{ asset: "contentQuarterlyCalendar", uploadedBy: "zoe", useAsCover: true }],
        },
      ],
    },
    {
      list: "In Progress",
      cards: [
        {
          title: "Write the Northshore customer story",
          assignee: "zoe",
          description: [
            "Draft the Northshore story around replacing five team trackers with one shared operating rhythm.",
            "Keep the three-week parallel migration in the story, use only verified numbers, and mark quotations awaiting approval.",
          ],
          createdBy: "ben",
          attachments: [
            { asset: "contentCustomerStoryDraft", uploadedBy: "zoe", useAsCover: true },
            { asset: "screenshotRedlineReview", uploadedBy: "zoe" },
          ],
          checklists: [{
            title: "Story draft",
            items: [
              { text: "Verify company and team context", completedBy: "grace", completedOffsetHours: 6 },
              { text: "Draft problem and decision sections", completedBy: "zoe", completedOffsetHours: 12 },
              { text: "Validate migration details with customer success" },
              { text: "Add only sourced outcome numbers" },
              { text: "Prepare customer approval copy" },
            ],
          }],
          comments: [
            { author: "ben", hoursAfterCreation: 14, body: "The migration paragraph is too smooth. They ran the old trackers in parallel for three weeks, and that detail makes the story more trustworthy.", mentions: ["zoe"] },
            { author: "zoe", hoursAfterCreation: 25, body: "Agreed. I added the parallel period and the Friday reconciliation they used before switching fully.", mentions: ["ben"] },
          ],
        },
        {
          title: "Assemble the monthly customer newsletter",
          assignee: "grace",
          description: [
            "Build this month’s customer newsletter around the autumn preview, workspace guide, and two small product improvements.",
            "Use one primary CTA; keep the other items as short, useful links for customers outside the campaign audience.",
          ],
          dueOffsetDays: 6,
          createdBy: "zoe",
          attachments: [{ asset: "contentNewsletterAssembly", uploadedBy: "grace", useAsCover: true }],
          checklists: [{
            title: "Newsletter assembly",
            items: [
              { text: "Collect product update summaries", completedBy: "grace", completedOffsetHours: 9 },
              { text: "Write autumn preview" },
              { text: "Confirm help-centre destination" },
              { text: "Build and test the email" },
              { text: "Check suppression lists" },
            ],
          }],
        },
        {
          title: "Edit the campaign announcement article",
          assignee: "zoe",
          description: [
            "Turn Amelia’s draft into a concise customer explanation of what changed and why shared structure matters.",
            "Keep the personal opening, remove internal launch history, and align product terms with the campaign brief.",
          ],
          createdBy: "amelia",
          attachments: [{ asset: "contentAnnouncementEdit", uploadedBy: "zoe", useAsCover: true }],
          comments: [{ author: "amelia", hoursAfterCreation: 8, body: "Please keep the opening anecdote, but I agree the middle reads like an internal retrospective. Cut anything a customer needs our org chart to understand.", mentions: ["zoe"] }],
        },
        {
          title: "Draft the autumn product-update changelog post",
          assignee: "grace",
          description: [
            "Write the changelog around what the shared-workspace improvements let customers do; link to the help centre for full release detail.",
          ],
          createdBy: "zoe",
        },
      ],
    },
    {
      list: "Review & Approval",
      cards: [
        {
          title: "Editorial review: Northshore story",
          assignee: "ben",
          description: [
            "Review the Northshore draft for evidence, customer sensitivity, and whether the headline matches the actual outcome.",
          ],
          createdBy: "zoe",
          dueOffsetDays: 3,
          attachments: [{ asset: "contentEditorialReview", uploadedBy: "ben", useAsCover: true }],
        },
        {
          title: "Approve the newsletter send",
          assignee: "amelia",
          description: [
            "Approve the rendered newsletter, subject line, audience, and links; product facts are already checked, so focus on value and tone.",
          ],
          createdBy: "grace",
          attachments: [{ asset: "contentNewsletterApproval", uploadedBy: "grace", useAsCover: true }],
        },
      ],
    },
    {
      list: "Waiting on Others",
      cards: [
        {
          title: "Customer approval of final story",
          assignee: "ben",
          description: [
            "Northshore is reviewing the final story, two quotations, team-size wording, and screenshots; text is approved but image review is still open.",
          ],
          createdBy: "grace",
          dueOffsetDays: -3,
          labels: ["Copy & Content", "Blocked"],
          comments: [
            { author: "grace", hoursAfterCreation: 10, body: "Their operations lead approved the text. Brand is still checking whether the dashboard screenshot reveals a client name in the filter menu.", mentions: ["ben", "zoe"] },
            { author: "ben", hoursAfterCreation: 22, body: "Let us send the clean no-screenshot layout today. We can add the product image later without holding the publication slot.", mentions: ["grace"] },
          ],
        },
        {
          title: "Receive benchmark data from research partner",
          assignee: "zoe",
          description: [
            "Waiting for the anonymised operations-work survey cut and methodology note. No percentages enter copy or design until weighting and exclusions are documented.",
          ],
          createdBy: "ben",
          attachments: [{ asset: "contentBenchmarkValidation", uploadedBy: "zoe", useAsCover: true }],
        },
      ],
    },
    {
      list: "Done",
      cards: [
        {
          title: "Northshore interview questions approved",
          assignee: "ben",
          description: [
            "Northshore and Customer Success approved the interview structure, sensitive topics, and recording language; speculative ROI questions were removed.",
          ],
          createdBy: "zoe",
          createdDaysAgo: 19,
        },
        {
          title: "Previous quarter's content calendar shared",
          assignee: "zoe",
          description: [
            "The prior quarter’s calendar records owners, audiences, distribution, and protected product-change capacity; eleven of fourteen pieces shipped.",
          ],
          createdBy: "ben",
          createdDaysAgo: 32,
          comments: [{ author: "amelia", hoursAfterCreation: 20, body: "The visible dropped work is helpful. Please carry that convention into next quarter instead of quietly moving everything we choose not to publish.", mentions: ["zoe"] }],
        },
        {
          title: "Customer quote library organised",
          assignee: "grace",
          description: [
            "Approved customer quotes now include source, approval status, logo rights, and permitted context; expired approvals are flagged.",
          ],
          createdBy: "zoe",
        },
        {
          title: "SEO refresh of the top ten articles",
          assignee: "zoe",
          description: [
            "The ten highest-traffic articles now use current product terms, accurate links, and clearer intent; two were redirected instead of padded with keywords.",
          ],
          createdBy: "leo",
          createdDaysAgo: 38,
        },
        {
          title: "Editorial style guide updated",
          assignee: "zoe",
          description: [
            "The style guide now covers product spelling, capitalisation, quotation rules, and the refreshed voice in short examples people will actually use.",
          ],
          createdBy: "zoe",
          createdDaysAgo: 44,
        },
      ],
    },
  ]);

  const eventsCards = buildMarketingCards([
    {
      list: "Ideas & Requests",
      cards: [
        {
          title: "Small customer operations roundtable",
          assignee: "omar",
          description: [
            "Explore an off-the-record roundtable for eight to ten operations leads standardising work across teams; the value is peer exchange, not a disguised demo.",
          ],
          createdBy: "amelia",
        },
        {
          title: "Regional operations conference sponsorship",
          assignee: "omar",
          description: [
            "Assess the regional operations conference as a possible spring sponsorship after two customers independently mentioned attending.",
            "Compare attendee fit, speaking access, lead terms, delivery cost, and what current work we would stop to fund it.",
          ],
          createdBy: "ben",
        },
        {
          title: "Host customer-only office hours",
          assignee: "omar",
          description: [
            "Test a low-production customer office-hours session where each attendee brings one workflow question and leaves with a practical next step.",
          ],
          createdBy: "grace",
        },
      ],
    },
    {
      list: "Ready to Start",
      cards: [
        {
          title: "Write the partner webinar brief",
          assignee: "omar",
          description: [
            "Write the Orbiflow webinar brief around one repeatable workflow, with clear speaker roles, demo boundaries, consent, and follow-up.",
          ],
          createdBy: "ben",
          checklists: [{
            title: "Brief inputs",
            items: [
              { text: "Confirm the audience with partner marketing", completedBy: "omar", completedOffsetHours: 5 },
              { text: "Agree the single learning outcome" },
              { text: "Define demo ownership and boundaries" },
              { text: "Document lead-sharing consent" },
            ],
          }],
        },
        {
          title: "Shortlist next quarter's event opportunities",
          assignee: "omar",
          description: [
            "Score next quarter’s inbound events on audience fit, speaking quality, partner value, preparation cost, and follow-up capacity; declining is valid.",
          ],
          createdBy: "amelia",
        },
      ],
    },
    {
      list: "In Progress",
      cards: [
        {
          title: "Organise the autumn customer webinar",
          assignee: "omar",
          description: [
            "Coordinate the autumn webinar through rehearsal, broadcast, recording handoff, and follow-up.",
            "The date is fixed; the open risks are the guest speaker’s rehearsal hold and the partner demo account permissions.",
          ],
          dueOffsetDays: 1,
          dueDateSlot: "endOfWorkDay",
          createdBy: "ben",
          watchers: ["amelia", "grace", "leo"],
          checklists: [{
            title: "Webinar production",
            items: [
              { text: "Confirm run of show", completedBy: "omar", completedOffsetHours: 7 },
              { text: "Book speaker rehearsal" },
              { text: "Prepare backup demo recording" },
              { text: "Configure attendee questions and moderation" },
              { text: "Write recording handoff notes" },
            ],
          }],
          comments: [
            { author: "grace", hoursAfterCreation: 9, body: "The speaker can rehearse Wednesday at 15:00 UTC or Thursday at 09:00. Thursday is better for Nina if we want a final slide check.", mentions: ["omar", "nina"] },
            { author: "omar", hoursAfterCreation: 17, body: "I asked the partner to hold Thursday. Leo, please plan to use the backup recording if their sandbox permissions are not fixed by rehearsal.", mentions: ["leo"] },
          ],
        },
        {
          title: "Prepare the webinar presentation",
          assignee: "ben",
          description: [
            "Build the teaching section around three habits for recurring client work, with one end-to-end example and ten minutes for the partner workflow.",
          ],
          dueOffsetDays: 3,
          createdBy: "omar",
          comments: [{ author: "amelia", hoursAfterCreation: 13, body: "The second section currently repeats the first with different screenshots. Use that time to show what changes when an external partner joins the board.", mentions: ["ben"] }],
        },
        {
          title: "Build the webinar registration page",
          assignee: "leo",
          description: [
            "Build the co-branded registration page with speaker details, a clear learning outcome, timezone-aware timing, and consent-safe attribution.",
            "Keep registrants on Kanera’s list unless they explicitly opt into partner follow-up.",
          ],
          createdBy: "omar",
          checklists: [{
            title: "Registration flow",
            items: [
              { text: "Implement co-branded header", completedBy: "leo", completedOffsetHours: 8 },
              { text: "Add timezone-aware event display" },
              { text: "Verify partner consent wording" },
              { text: "Test confirmation and calendar file" },
            ],
          }],
        },
        {
          title: "Assemble the webinar follow-up sequence",
          assignee: "grace",
          description: [
            "Prepare separate recording and no-show emails while interest is fresh, with the partner send limited to explicit opt-ins.",
          ],
          createdBy: "omar",
          checklists: [{
            title: "Follow-up emails",
            items: [
              { text: "Draft attendee recording email", completedBy: "grace", completedOffsetHours: 7 },
              { text: "Draft no-show recap email" },
              { text: "Split partner-consented recipients" },
              { text: "Confirm the follow-up demo CTA with sales" },
            ],
          }],
        },
      ],
    },
    {
      list: "Review & Approval",
      cards: [
        {
          title: "Review the webinar run of show",
          assignee: "amelia",
          description: [
            "Review the 45-minute run of show for pace, handoffs, audience value, and a credible fallback if the live demo fails.",
          ],
          createdBy: "omar",
          dueOffsetDays: 2,
        },
        {
          title: "Approve the event invitation email",
          assignee: "ben",
          description: [
            "Check the invitation against the registration page: specific learning promise, clear partner role, and accurate audience wording.",
          ],
          createdBy: "grace",
        },
        {
          title: "Approve the partner co-branding on the registration page",
          assignee: "amelia",
          description: [
            "Approve the partner logo, co-branded header, attribution, and consent wording before the registration page goes public.",
          ],
          createdBy: "leo",
        },
      ],
    },
    {
      list: "Waiting on Others",
      cards: [
        {
          title: "Confirm guest speaker availability",
          assignee: "omar",
          description: [
            "Orbiflow’s operations director accepted in principle; rehearsal and broadcast holds are still unconfirmed.",
          ],
          createdBy: "grace",
          dueOffsetDays: 1,
          comments: [{ author: "omar", hoursAfterCreation: 21, body: "Their assistant confirmed the broadcast hold. I am leaving this here until the rehearsal is accepted as well; that is the harder dependency.", mentions: ["grace"] }],
        },
        {
          title: "Receive partner biography and headshot",
          assignee: "grace",
          description: [
            "Waiting for a 60-word biography, role confirmation, pronunciation note, and original headshot before the page leaves private preview.",
          ],
          createdBy: "omar",
        },
      ],
    },
    {
      list: "Done",
      cards: [
        {
          title: "Autumn webinar date confirmed",
          assignee: "omar",
          description: [
            "Kanera, the partner, and the customer speaker agreed the broadcast date, rehearsal window, and backup recording slot.",
          ],
          createdBy: "amelia",
          createdDaysAgo: 21,
        },
        {
          title: "Previous partner session retrospective",
          assignee: "omar",
          description: [
            "The retrospective covers attendance quality, question themes, handoffs, recording performance, and follow-up; autumn will use a shorter demo and one consent owner.",
          ],
          createdBy: "ben",
          createdDaysAgo: 34,
          comments: [{ author: "grace", hoursAfterCreation: 26, body: "I added the twelve registrations that arrived after the live date from the recording page. They change the follow-up total but not the attendance rate.", mentions: ["omar"] }],
        },
        {
          title: "Post-event survey questions finalised",
          assignee: "omar",
          description: [
            "The attendee survey is five decision-useful questions plus one open field, matching the gaps from the previous retrospective.",
          ],
          createdBy: "grace",
        },
        {
          title: "Speaker thank-you notes sent",
          assignee: "grace",
          description: [
            "The guest speaker and partner received personal thanks, early attendance figures, and an invitation to co-propose the spring session.",
          ],
          createdBy: "omar",
          createdDaysAgo: 30,
        },
      ],
    },
  ]);

  const requestCards = buildMarketingCards([
    {
      list: "Ideas & Requests",
      cards: [
        {
          title: "Sales deck update for procurement calls",
          assignee: "grace",
          description: [
            "Collect the five security, rollout, ownership, and support slides reps rebuild for procurement calls and test a modular appendix before making a second full deck.",
          ],
          createdBy: "ben",
          comments: [{ author: "grace", hoursAfterCreation: 12, body: "Three reps sent examples. They all rebuild the implementation timeline and security summary; the rest of the deck is already covered.", mentions: ["ben"] }],
        },
        {
          title: "Refresh the customer onboarding email sequence",
          assignee: "zoe",
          description: [
            "Map the current onboarding emails to real workspace milestones before rewriting; remove links and messages that no longer earn their place.",
          ],
          createdBy: "grace",
        },
        {
          title: "Sales one-pager for the finance buyer",
          assignee: "grace",
          description: [
            "Give finance stakeholders one page on cost, rollout effort, and ownership without turning it into another pricing sheet.",
          ],
          createdBy: "ben",
        },
        {
          title: "Localised deck for the DACH region",
          assignee: "grace",
          description: [
            "Scope a properly localised DACH core deck so regional reps stop hand-translating approved messaging inside active deals.",
          ],
          createdBy: "amelia",
        },
        {
          title: "Refresh the support canned responses",
          assignee: "zoe",
          description: [
            "Update saved replies with current product names, live help-centre links, and wording agents can still personalise.",
          ],
          createdBy: "grace",
        },
      ],
    },
    {
      list: "Ready to Start",
      cards: [
        {
          title: "Build a reusable case-study template",
          assignee: "nina",
          description: [
            "Design one case-study template with optional quote, metric, and photo blocks so stories are faster to produce without looking identical.",
          ],
          createdBy: "grace",
          labels: ["Design", "Copy & Content"],
        },
        {
          title: "Create a customer-success business review deck",
          assignee: "nina",
          description: [
            "Build a business-review deck for adoption, operating wins, risks, and next-quarter plans that still works with incomplete analytics.",
          ],
          createdBy: "grace",
          checklists: [{
            title: "Required layouts",
            items: [
              { text: "Executive summary" },
              { text: "Adoption with partial-data state" },
              { text: "Wins and evidence" },
              { text: "Risks, owners, and next steps" },
              { text: "Facilitator notes" },
            ],
          }],
        },
        {
          title: "Update the recruitment brochure",
          assignee: "zoe",
          description: [
            "Replace the recruitment brochure’s generic copy with the current company story, principles, hiring process, and HR-approved benefits.",
          ],
          createdBy: "grace",
          fieldValues: { Budget: 2_400, Campaign: "Recruitment campaign" },
        },
      ],
    },
    {
      list: "In Progress",
      cards: [
        {
          title: "Design the product overview document",
          assignee: "nina",
          description: [
            "Turn the approved overview into a concise PDF covering workspace structure, shared lists and fields, board guests, and a typical rollout.",
          ],
          dueOffsetDays: 8,
          createdBy: "ben",
          checklists: [{
            title: "Document sections",
            items: [
              { text: "Workspace model diagram", completedBy: "nina", completedOffsetHours: 7 },
              { text: "Shared structure example" },
              { text: "Guest-access explanation" },
              { text: "Rollout timeline" },
              { text: "Accessible PDF export" },
            ],
          }],
          comments: [
            { author: "ben", hoursAfterCreation: 11, body: "The workspace diagram is clear. The guest-access panel still implies guests join the whole workspace; please use the board-specific wording from the approved copy.", mentions: ["nina", "zoe"] },
            { author: "zoe", hoursAfterCreation: 19, body: "I replaced that panel and added the distinction between organisation members and board guests in one sentence.", mentions: ["ben"] },
          ],
        },
        {
          title: "Prepare recruitment campaign assets",
          assignee: "nina",
          description: [
            "Prepare role cards, employee-story crops, a referral image, and a careers header for engineering and Customer Success hiring.",
            "Use the refreshed system but keep the office photography candid; HR does not want an airbrushed workplace.",
          ],
          createdBy: "grace",
          checklists: [{
            title: "Campaign assets",
            items: [
              { text: "Engineering role card", completedBy: "nina", completedOffsetHours: 9 },
              { text: "Customer-success role card" },
              { text: "Employee-story crops" },
              { text: "Referral image" },
              { text: "Careers-page header" },
            ],
          }],
        },
        {
          title: "Rewrite the sales presentation copy",
          assignee: "zoe",
          description: [
            "Rewrite the sales story around the cost of rebuilding context across separate boards and trackers.",
            "Remove the unsupported one-day setup claim and give reps accurate proof for different audiences.",
          ],
          createdBy: "ben",
          comments: [{ author: "grace", hoursAfterCreation: 15, body: "Sales is comfortable losing the one-day setup claim. Can we replace it with the actual rollout steps so reps have a useful answer when asked?", mentions: ["zoe"] }],
        },
      ],
    },
    {
      list: "Review & Approval",
      cards: [
        {
          title: "Review the product overview document",
          assignee: "ben",
          description: [
            "Review the PDF for product accuracy and visible proof, with extra attention to guest access and rollout—the two sections that caused follow-up questions before.",
          ],
          createdBy: "nina",
          dueOffsetDays: 9,
        },
        {
          title: "Approve the recruitment campaign assets",
          assignee: "amelia",
          description: [
            "Review the careers page, role cards, and employee stories as one candidate experience; confirm the tone is credible, inclusive, and recognisably Kanera.",
          ],
          createdBy: "grace",
        },
      ],
    },
    {
      list: "Waiting on Others",
      cards: [
        {
          title: "Sales feedback on procurement slides",
          assignee: "grace",
          description: [
            "Three reps are using the procurement appendix in real calls; collect what was missing, ignored, or moved elsewhere—not just design opinions.",
          ],
          createdBy: "ben",
          comments: [{ author: "grace", hoursAfterCreation: 22, body: "Two reps have used it. Both skipped the support slide but asked for a clearer data-migration sequence; I am waiting on the enterprise call before consolidating.", mentions: ["ben", "nina"] }],
        },
        {
          title: "HR confirmation of recruitment wording",
          assignee: "zoe",
          description: [
            "Waiting for HR to confirm benefits, location, interview, equal-opportunity, and flexible-work wording against the live role templates.",
          ],
          createdBy: "grace",
          dueOffsetDays: 5,
        },
      ],
    },
    {
      list: "Done",
      cards: [
        {
          title: "Customer-success presentation delivered",
          assignee: "nina",
          description: [
            "Customer Success received the kickoff deck with modular agenda, responsibility map, first-month plan, and facilitator notes; two follow-ups were split out after enablement.",
          ],
          createdBy: "grace",
          createdDaysAgo: 18,
        },
        {
          title: "Previous sales brochure retired",
          assignee: "zoe",
          description: [
            "The outdated brochure is removed from shared drive, sales favourites, and follow-up sequences; old links now point to the current overview.",
          ],
          createdBy: "ben",
          createdDaysAgo: 29,
          comments: [{ author: "ben", hoursAfterCreation: 18, body: "I checked the three most common email templates and they all resolve to the new overview. Closing this before somebody resurrects the old PDF.", mentions: ["zoe"] }],
        },
        {
          title: "Leadership offsite slide template delivered",
          assignee: "nina",
          description: [
            "Leadership has a reusable quarterly offsite template with standard sections, open content areas, and the refreshed system without a sales-deck feel.",
          ],
          createdBy: "grace",
        },
        {
          title: "HR careers-page copy shipped",
          assignee: "zoe",
          description: [
            "The careers page now uses the specific company story and HR-confirmed benefits and equal-opportunity wording instead of the generic placeholder.",
          ],
          createdBy: "grace",
          createdDaysAgo: 24,
        },
      ],
    },
  ]);

  return {
    key: "marketing",
    name: "Marketing & Creative",
    icon: "speakerphone",
    accentColor: "rose",
    createdBy: "amelia",
    members: [
      { user: "amelia", role: "owner" },
      { user: "ben", role: "editor" },
      { user: "nina", role: "editor" },
      { user: "zoe", role: "editor" },
      { user: "leo", role: "editor" },
      { user: "omar", role: "editor" },
      { user: "grace", role: "editor" },
    ],
    lists: [
      { name: "Ideas & Requests", icon: "bulb" },
      { name: "Ready to Start", icon: "player-play" },
      { name: "In Progress", icon: "progress" },
      { name: "Review & Approval", icon: "checks" },
      { name: "Waiting on Others", icon: "clock-pause" },
      { name: "Done", icon: "circle-check" },
    ],
    // Marketing is the showcase workspace for demos and screenshots, so its cards carry a realistic
    // movement history. The happy path runs Ideas -> Ready -> In Progress -> Review -> Done; work that
    // stalls is pulled out of "In Progress" into "Waiting on Others".
    listFlow: ["Ideas & Requests", "Ready to Start", "In Progress", "Review & Approval", "Done"],
    listSideEntries: { "Waiting on Others": "In Progress" },
    customFields: [
      { name: "Campaign", icon: "speakerphone", type: "text" },
      { name: "Budget", icon: "cash", type: "number" },
      { name: "Approved", icon: "checkbox", type: "checkbox" },
    ],
    labels: [
      { name: "Campaign", color: "blue" },
      { name: "Design", color: "violet" },
      { name: "Copy & Content", color: "green" },
      { name: "Email", color: "purple" },
      { name: "Social", color: "sky" },
      { name: "Web", color: "teal" },
      { name: "Analytics", color: "indigo" },
      { name: "Events", color: "orange" },
      { name: "Partner", color: "amber" },
      { name: "Internal Request", color: "gray" },
      { name: "Blocked", color: "red" },
    ],
    notes: [
      {
        title: "Autumn Campaign Launch Plan",
        icon: "speakerphone",
        owner: "ben",
        content: note(
          "Shared plan for the autumn campaign launch across creative, content, web, email, social, and partner activity.",
          "Ben owns launch readiness and the final schedule. Amelia gives final approval; Nina owns campaign artwork, Zoe owns customer-facing copy, Leo owns web and measurement, and Omar coordinates partner and event dependencies.",
          "The launch remains blocked until product confirms the headline promise. Channel owners can continue production, but nothing should be scheduled or sent with placeholder wording.",
          "Launch-day rule: update the main launch card first when a dependency changes so the readiness view remains trustworthy.",
        ),
      },
      {
        title: "Marketing Team Operating Guide",
        icon: "route",
        owner: "amelia",
        content: note(
          "How Marketing & Creative work moves through this workspace.",
          "Ideas & Requests is for uncommitted work. A card moves to Ready to Start only when the audience, owner, intended outcome, and essential inputs are clear.",
          "Use Review & Approval for a specific decision, not general feedback. Name the approver in a comment and describe what changed since the previous review.",
          "Waiting on Others should identify the dependency and next follow-up date. Completed work belongs in Done with final files or destination links attached where useful.",
        ),
        children: [
          {
            title: "Creative Review Standards",
            icon: "palette",
            owner: "nina",
            content: note(
              "Creative reviews should answer whether the work meets the brief, works in its intended placements, and is ready for production.",
              "Review desktop and mobile crops together. Check contrast, safe areas, logo clearance, and whether partner variants still feel like the same campaign.",
              "Keep subjective exploration in working files. Card comments should record decisions, concrete changes, and final approval.",
            ),
          },
          {
            title: "Copy Approval Checklist",
            icon: "writing",
            owner: "zoe",
            content: note(
              "Before requesting approval, confirm the audience, single promise, supporting proof, call to action, and destination are consistent.",
              "Avoid unsourced performance claims. Customer quotations must have a traceable interview or approval source, and partner copy must use the wording agreed with the partner.",
              "For email and social, include the final subject line or post copy in the review context so approvers are not judging an isolated headline.",
            ),
          },
        ],
      },
      {
        title: "Campaign Measurement Conventions",
        icon: "chart-dots-3",
        owner: "leo",
        content: note(
          "Use one campaign name across landing pages, email, social, partner links, and reporting. Preserve the original source when a visitor moves between campaign pages.",
          "Primary measures are qualified demo requests and campaign-assisted opportunities. Landing-page conversion, email engagement, partner referrals, and event registrations are diagnostic measures.",
          "Compare against the previous quarter where possible and label directional numbers clearly when attribution is incomplete.",
        ),
      },
    ],
    boards: [
      {
        key: "autumn-campaign-launch",
        name: "Autumn Campaign Launch",
        description: "Main campaign board for a coordinated, deadline-driven autumn launch.",
        icon: "rocket",
        iconColor: "rose",
        createdBy: "ben",
        notes: [
          {
            title: "Launch Week Run of Show",
            icon: "calendar-clock",
            owner: "grace",
            content: note(
              "Working sequence for autumn campaign launch week.",
              "Monday: final copy and creative approval. Tuesday: landing-page and tracking smoke test. Wednesday: partner handoff and email suppression check. Thursday: schedule social posts and confirm support coverage. Friday: launch, monitor, and record exceptions.",
              "Ben makes the go/no-go call with Amelia. Grace keeps the schedule current; channel owners report blockers on the main launch card rather than maintaining separate status threads.",
              "If tracking, consent, or the landing-page form is not ready, pause distribution rather than launching partially.",
            ),
          },
        ],
        cards: autumnCampaignCards,
      },
      {
        key: "brand-refresh",
        name: "Brand Refresh",
        description: "Creative production and brand-system work for a consistent visual identity.",
        icon: "palette",
        iconColor: "violet",
        createdBy: "nina",
        notes: [
          {
            title: "Brand Refresh Working Principles",
            icon: "color-swatch",
            owner: "nina",
            content: note(
              "The refresh should make Kanera feel clearer and more confident without discarding the recognisable parts of the current identity.",
              "Prioritise typography, spacing, colour roles, illustration treatment, and repeatable campaign layouts before expanding the asset library.",
              "Test proposed changes in real landing-page, email, social, and presentation examples. A component is not approved until it works in both light and dark contexts where applicable.",
              "Keep exploratory files in the design workspace; attach only review-ready exports and decision snapshots to cards.",
            ),
          },
        ],
        cards: brandRefreshCards,
      },
      {
        key: "website-and-landing-pages",
        name: "Website & Landing Pages",
        description: "Website, landing-page, analytics, accessibility, and growth work.",
        icon: "world-www",
        iconColor: "teal",
        createdBy: "leo",
        notes: [
          {
            title: "Website Release Checklist",
            icon: "world-check",
            owner: "leo",
            content: note(
              "Checks required before a landing page or material website change is published.",
              "Confirm responsive layouts, keyboard navigation, visible focus, form errors, metadata, analytics events, campaign-source persistence, consent wording, and the no-JavaScript or missing-content fallback.",
              "Test the production destination rather than relying only on preview. Record redirects and any intentionally deferred accessibility or performance work on the release card.",
              "For campaign pages, the page owner and campaign owner should both approve the final promise, call to action, and measurement setup.",
            ),
          },
        ],
        cards: websiteCards,
      },
      {
        key: "content-and-customer-stories",
        name: "Content & Customer Stories",
        description: "Editorial, newsletter, thought-leadership, and customer-story work.",
        icon: "article",
        iconColor: "green",
        createdBy: "zoe",
        notes: [
          {
            title: "Editorial Calendar and Review Rhythm",
            icon: "calendar-stats",
            owner: "zoe",
            content: note(
              "Use this board for committed editorial work, customer stories, newsletters, and research-led content.",
              "Every draft needs a named audience, publication destination, intended reader action, and source owner. Customer stories also need quotation and logo approval before final design.",
              "Zoe runs editorial review on Tuesdays and Thursdays. Requests arriving after Thursday review normally move into the following week unless they support an active launch or customer commitment.",
              "Substantive feedback belongs in the card or working document. Approval comments should state what is approved and note any remaining distribution restrictions.",
            ),
          },
        ],
        cards: contentCards,
      },
      {
        key: "events-and-partnerships",
        name: "Events & Partnerships",
        description: "Webinars, partner activity, speakers, and deadline-driven event coordination.",
        icon: "calendar-event",
        iconColor: "orange",
        createdBy: "omar",
        notes: [
          {
            title: "Event Delivery Playbook",
            icon: "presentation",
            owner: "omar",
            content: note(
              "Minimum operating checklist for webinars, partner sessions, conferences, and customer roundtables.",
              "Confirm the audience, learning outcome, speaker owner, consent model, registration flow, run of show, rehearsal date, moderation plan, and recording handoff before promotion begins.",
              "Partner activity must document lead-sharing terms and approved co-branded wording. Never assume registration consent covers a partner follow-up.",
              "After the event, record attendance, questions, follow-up owner, recording destination, and any reusable clips or customer insights.",
            ),
          },
        ],
        cards: eventsCards,
      },
      {
        key: "marketing-requests",
        name: "Marketing Requests",
        description: "Operational requests from sales, HR, leadership, and customer-facing teams.",
        icon: "inbox",
        iconColor: "gray",
        createdBy: "grace",
        notes: [
          {
            title: "Marketing Request Intake Guide",
            icon: "inbox",
            owner: "grace",
            content: note(
              "Use this board for requests from Sales, Customer Success, People, Finance, leadership, and other internal teams.",
              "A useful request includes the audience, business need, required format, destination, deadline, requester, approver, and any source material. A requested date is not a committed delivery date until Marketing confirms scope.",
              "Grace triages new requests and routes specialist work to the relevant board. Small production tasks may remain here; campaigns, web builds, editorial work, and events should move to their dedicated boards.",
              "Urgent requests should explain the consequence of missing the date and what existing work can move to make room.",
            ),
          },
        ],
        cards: requestCards,
      },
    ],
  };
}

function buildDevopsWorkspace(): SeedWorkspace {
  return {
    key: "devops",
    name: "DevOps",
    icon: "server",
    accentColor: "amber",
    createdBy: "amelia",
    members: [
      { user: "amelia", role: "owner" },
      { user: "grace", role: "admin" },
      { user: "omar", role: "editor" },
      { user: "henry", role: "editor" },
      { user: "priya", role: "observer" },
    ],
    lists: [
      { name: "Intake", icon: "inbox" },
      { name: "Planned", icon: "calendar" },
      { name: "Implementing", icon: "code" },
      { name: "Awaiting Window", icon: "clock" },
      { name: "Monitoring", icon: "activity" },
      { name: "Completed", icon: "circle-check" },
      { name: "Follow-up", icon: "refresh" },
    ],
    customFields: [
      { name: "Service", icon: "server-cog", type: "text" },
      { name: "Maintenance Window", icon: "calendar-clock", type: "text" },
      { name: "Customer Impact", icon: "alert-circle", type: "checkbox" },
    ],
    labels: [
      { name: "Incident", color: "red" },
      { name: "Automation", color: "blue" },
      { name: "Security", color: "purple" },
      { name: "Infrastructure", color: "gray" },
      { name: "Compliance", color: "amber" },
    ],
    notes: [
      {
        title: "Incident Response Runbook",
        icon: "alert-triangle",
        owner: "grace",
        content: note(
          "🛟 Workspace runbook for production incidents and follow-up work.",
          "First response: identify customer impact, link the active incident card, assign an owner, and keep the Monitoring list updated until the incident is stable.",
          "Follow-up should capture root cause, alert changes, and any runbook updates before the card moves to Completed.",
          "Status page: https://status.kanera.test",
        ),
        children: [
          {
            title: "Upload Storage Outage Drill",
            icon: "cloud-upload",
            owner: "omar",
            content: note(
              "Practice both local disk pressure and object-store credential failure.",
              "Expected evidence: alert timeline, recovery steps, customer impact decision, and the owner for any automation card created afterward.",
              "Drill notes: https://ops.kanera.test/runbooks/upload-storage-outage",
            ),
          },
        ],
      },
      {
        title: "Access Review Checklist",
        icon: "lock-check",
        owner: "amelia",
        content: note(
          "Quarterly checklist for access and compliance reviews.",
          "- 🔐 Review dormant admin accounts\n- 📷 Capture evidence for board guest controls\n- 🧾 Confirm audit export retention copy\n- ⚠️ Record exceptions before closing the review",
        ),
      },
    ],
    boards: [
      {
        key: "production-reliability",
        name: "Production Reliability",
        description: "Operational board for deploy safety, observability work, and production follow-up items.",
        icon: "shield-check",
        iconColor: "green",
        createdBy: "grace",
        notes: [
          {
            title: "Realtime Synthetic Check Design",
            icon: "activity-heartbeat",
            owner: "grace",
            content: note(
              "Board-specific design notes for the websocket room join synthetic.",
              "The check should join a workspace room, join a board room, emit a harmless probe, and alert only when room behavior differs from API health.",
              "Success criteria: catches stale board clients without creating noise during normal deploy windows.",
              "Dashboard draft: https://ops.kanera.test/dashboards/realtime-synthetic",
            ),
          },
          {
            title: "Queue Latency Watch Notes",
            icon: "timeline-event",
            owner: "henry",
            content: note(
              "Monitoring notes for background job latency after queue tuning.",
              "Watch attachment cleanup, overdue notifications, and digest scheduling together. A single slow queue is acceptable during maintenance, but repeated customer-impacting delay should create a follow-up card.",
            ),
          },
        ],
        cards: [
          {
            title: "Rotate API signing keys in staging",
            description: note(
              "Run the signing-key rotation in staging with the production sequence and a deliberately short overlap window.",
              "Record JWKS cache timing and the rollback step if an old token is rejected before clients refresh.",
            ),
            list: "Planned",
            createdBy: "grace",
            assignees: ["grace", "omar"],
            labels: ["Security", "Infrastructure"],
            dueOffsetDays: 5,
            dueDateSlot: "morning",
            fieldValues: { Service: "api-auth", "Maintenance Window": "Tue 22:00 UTC", "Customer Impact": false },
            attachments: [{ asset: "releaseTemplate", uploadedBy: "grace" }],
            checklists: [
              {
                title: "Rotation rehearsal",
                items: [
                  { text: "Generate staging key pair and publish JWKS", assignee: "grace", dueOffsetDays: 1, dueDateSlot: "morning", completedBy: "grace", completedOffsetHours: 11 },
                  { text: "Verify old token grace period in API logs", assignee: "omar", dueOffsetDays: 2, dueDateSlot: "afternoon" },
                  { text: "Update rollback note in runbook", dueOffsetDays: 4, dueDateSlot: "morning" },
                ],
              },
            ],
            comments: [
              { author: "priya", hoursAfterCreation: 14, body: "Please post the new JWKS cache timing before we run this in production." },
            ],
          },
          {
            title: "Tune alert noise for failed attachment uploads",
            description: note(
              "A single customer connection problem is paging the attachment rotation before there is evidence of a provider issue.",
              "Separate warning from page thresholds, but keep a broad failure burst loud enough to wake the on-call engineer.",
            ),
            list: "Implementing",
            createdBy: "omar",
            assignees: ["omar", "grace"],
            labels: ["Automation", "Incident"],
            dueOffsetDays: 2,
            dueDateSlot: "afternoon",
            fieldValues: { Service: "attachment-pipeline", "Maintenance Window": "No window required", "Customer Impact": true },
            comments: [
              { author: "amelia", hoursAfterCreation: 9, body: "As long as we keep signal for broad provider issues, I am happy to reduce the noise floor." },
            ],
          },
          {
            title: "Add synthetic check for board room joins",
            description: note(
              "API health is green even when a board client cannot rejoin its rooms.",
              "Add a harmless check that joins the workspace room and board room separately, then reports which step failed.",
            ),
            list: "Implementing",
            createdBy: "grace",
            assignees: ["grace", "henry"],
            labels: ["Automation", "Infrastructure"],
            dueOffsetDays: 6,
            dueDateSlot: "endOfWorkDay",
            fieldValues: { Service: "realtime", "Maintenance Window": "Wed 09:00 UTC", "Customer Impact": false },
            attachments: [{ asset: "architectureRecord", uploadedBy: "grace" }],
          },
          {
            title: `Prepare ${seedMonthName(1)} database vacuum window`,
            description: note(
              "Demo imports have left enough attachment churn to make the development database vacuum worth scheduling.",
              "Confirm the Saturday window, expected lock time, and who will verify uploads when the maintenance completes.",
            ),
            list: "Awaiting Window",
            createdBy: "omar",
            assignees: ["omar"],
            labels: ["Infrastructure"],
            dueOffsetDays: 9,
            fieldValues: { Service: "postgres", "Maintenance Window": "Sat 01:00 UTC", "Customer Impact": true },
          },
          {
            title: "Monitor background job latency after queue tuning",
            description: note(
              "Default queue concurrency was lowered yesterday; keep this card open until a full week of cleanup and reminder timings is available.",
              "The useful signal is customer-facing delay, not a queue that briefly grows during maintenance.",
            ),
            list: "Monitoring",
            createdBy: "grace",
            assignees: ["grace", "henry"],
            labels: ["Automation"],
            dueOffsetDays: 4,
            fieldValues: { Service: "jobs", "Maintenance Window": "No window required", "Customer Impact": false },
            comments: [
              { author: "henry", hoursAfterCreation: 13, body: "If the metrics settle, I will update the weekly ops note with the new baseline." },
            ],
          },
          {
            title: "Create recovery drill for upload storage outage",
            description: note(
              "Rehearse two different failures: local disk pressure in development and expired object-store credentials in hosted environments.",
              "Capture the first alert, the customer-impact decision, and the person who owns the first ten minutes of recovery.",
            ),
            list: "Intake",
            createdBy: "amelia",
            assignees: ["grace", "omar"],
            labels: ["Incident", "Infrastructure"],
            dueOffsetDays: 14,
            fieldValues: { Service: "storage", "Maintenance Window": "TBD", "Customer Impact": true },
            attachments: [{ asset: "onboardingChecklist", uploadedBy: "amelia" }],
          },
          {
            title: "Follow up on overnight queue backlog",
            description: note(
              "The overnight backlog cleared without intervention, but the logs do not yet distinguish database pressure from storage latency.",
              "Close the incident with one evidence-backed explanation, even if confidence remains low.",
            ),
            list: "Follow-up",
            createdBy: "henry",
            assignees: ["henry", "grace"],
            labels: ["Incident"],
            dueOffsetDays: 2,
            fieldValues: { Service: "jobs", "Maintenance Window": "N/A", "Customer Impact": true },
            checklists: [
              {
                title: "Incident follow-up",
                items: [
                  { text: "Attach query log excerpt from backlog window", dueOffsetDays: 0, dueDateSlot: "afternoon" },
                  { text: "Compare storage latency with queue depth", dueOffsetDays: 1, dueDateSlot: "morning" },
                  { text: "Write closing note with root-cause confidence", dueOffsetDays: 2, dueDateSlot: "afternoon" },
                ],
              },
            ],
            comments: [
              { author: "omar", hoursAfterCreation: 5, body: "I have query logs from the spike window if we want to correlate them with storage timings." },
            ],
          },
          {
            title: "Complete runbook for S3 credential rotation",
            description: note(
              "The S3 rotation steps are now in one operator runbook instead of split across tickets and chat.",
              "The worked example includes writing the encrypted config back and checking the first successful upload.",
            ),
            list: "Completed",
            createdBy: "grace",
            assignees: ["grace"],
            labels: ["Security", "Compliance"],
            dueOffsetDays: -3,
            fieldValues: { Service: "storage", "Maintenance Window": "Completed", "Customer Impact": false },
            attachments: [{ asset: "apiRolloutPlan", uploadedBy: "grace" }],
          },
          {
            title: "Document websocket capacity assumptions",
            description: note(
              "The load test established a useful ceiling, but its assumptions were still buried in an ops thread.",
              "Document expected board-room behaviour, reconnect volume, and the point at which we need another capacity test.",
            ),
            list: "Completed",
            createdBy: "omar",
            assignees: ["omar"],
            labels: ["Infrastructure"],
            dueOffsetDays: -7,
            fieldValues: { Service: "realtime", "Maintenance Window": "Completed", "Customer Impact": false },
          },
          {
            title: "Plan dashboard for local dev environment health",
            description: note(
              "Local demos now depend on more moving parts, so add one health view before the next customer walkthrough.",
              "Start with database reachability, upload disk usage, and websocket status; build-tool diagnostics can wait.",
            ),
            list: "Planned",
            createdBy: "henry",
            assignees: ["henry", "grace"],
            labels: ["Automation", "Infrastructure"],
            dueOffsetDays: 11,
            fieldValues: { Service: "dev-platform", "Maintenance Window": "No window required", "Customer Impact": false },
          },
        ],
      },
      {
        key: "access-and-compliance",
        name: "Access & Compliance",
        description: "Board for access reviews, audit prep, and compliance-sensitive operational changes.",
        icon: "lock-access",
        iconColor: "amber",
        createdBy: "amelia",
        members: [
          { user: "amelia", role: "owner" },
          { user: "grace", role: "admin" },
          { user: "henry", role: "editor" },
        ],
        notes: [
          {
            title: "Dormant Admin Review Evidence",
            icon: "user-shield",
            owner: "henry",
            content: note(
              "Private evidence notes for dormant admin review.",
              "Capture the source query, reviewer, downgrade decision, and support confirmation before closing the access review card.",
              "Anything with customer impact should stay on this board until the action is complete.",
              "Evidence folder: https://ops.kanera.test/audit/2026-q2/access-review",
            ),
          },
          {
            title: "Audit Export Retention Policy",
            icon: "file-certificate",
            owner: "amelia",
            content: note(
              "Draft policy note for audit log export retention.",
              "Exports should expire on a predictable schedule, communicate the expiry in admin copy, and leave enough audit trail to prove who generated the bundle.",
            ),
          },
        ],
        cards: [
          {
            title: "Review dormant admin accounts",
            description: note(
              "Review organisation admins who have not logged in since the winter migration and downgrade anything no longer justified.",
              "Keep the source export and each exception decision with the card so the quarterly review can be reconstructed.",
            ),
            list: "Intake",
            createdBy: "henry",
            assignees: ["henry", "grace"],
            labels: ["Security", "Compliance"],
            dueOffsetDays: 3,
            dueDateSlot: "morning",
            fieldValues: { Service: "identity", "Maintenance Window": "No window required", "Customer Impact": false },
            checklists: [
              {
                title: "Access review evidence",
                items: [
                  { text: "Export dormant org admin list", dueOffsetDays: 1, dueDateSlot: "morning", completedBy: "henry", completedOffsetHours: 8 },
                  { text: "Confirm legitimate exceptions with Amelia", dueOffsetDays: 2, dueDateSlot: "afternoon" },
                  { text: "Downgrade stale admin accounts", dueOffsetDays: 3, dueDateSlot: "morning" },
                ],
              },
            ],
            comments: [
              { author: "amelia", hoursAfterCreation: 6, body: "Start with org admins who have not logged in since the winter migration." },
            ],
          },
          {
            title: "Prepare evidence pack for board privacy controls",
            description: note(
              "Prepare screenshots showing the difference between a workspace member and a guest shared to one board.",
              "Use the seeded demo accounts so the walkthrough shows the real access boundary rather than a diagram alone.",
            ),
            list: "Planned",
            createdBy: "grace",
            assignees: ["grace", "henry"],
            labels: ["Compliance", "Security"],
            dueOffsetDays: 7,
            fieldValues: { Service: "permissions", "Maintenance Window": "No window required", "Customer Impact": false },
            attachments: [{ asset: "releaseTemplate", uploadedBy: "grace" }],
          },
          {
            title: "Implement audit log export retention rule",
            description: note(
              "Give exported audit bundles a predictable expiry in both local seed data and hosted environments.",
              "The admin copy must say when the bundle expires and still leave evidence of who generated it.",
            ),
            list: "Implementing",
            createdBy: "amelia",
            assignees: ["grace", "henry"],
            labels: ["Compliance", "Automation"],
            dueOffsetDays: 8,
            dueDateSlot: "endOfWorkDay",
            fieldValues: { Service: "audit-export", "Maintenance Window": "Fri 23:00 UTC", "Customer Impact": false },
            comments: [
              { author: "henry", hoursAfterCreation: 10, body: "I can write the policy note once the retention period is locked." },
            ],
          },
          {
            title: "Schedule privileged access review",
            description: note(
              "Put the next privileged-access review on a recurring cadence with named reviewers and evidence links.",
              "The calendar invite should replace the current manual chase, not become another place where decisions are recorded.",
            ),
            list: "Awaiting Window",
            createdBy: "henry",
            assignees: ["henry"],
            labels: ["Compliance"],
            dueOffsetDays: 10,
            fieldValues: { Service: "identity", "Maintenance Window": "Wed 15:00 UTC", "Customer Impact": false },
          },
          {
            title: "Monitor completed MFA rollout for exceptions",
            description: note(
              "MFA is rolled out; keep a short exception watch for customer admins who cannot complete the new flow.",
              "Log each support case here until the lockout rate is quiet enough to close the rollout.",
            ),
            list: "Monitoring",
            createdBy: "grace",
            assignees: ["grace", "henry"],
            labels: ["Security"],
            dueOffsetDays: 4,
            fieldValues: { Service: "identity", "Maintenance Window": "N/A", "Customer Impact": true },
          },
          {
            title: "Complete vendor access inventory",
            description: note(
              "The vendor inventory records which infrastructure and support tools each supplier can access and who reviews that access.",
              "It is ready for the governance checkpoint next month; changes now belong in a follow-up card.",
            ),
            list: "Completed",
            createdBy: "henry",
            assignees: ["henry"],
            labels: ["Compliance"],
            dueOffsetDays: -3,
            fieldValues: { Service: "vendor-access", "Maintenance Window": "Completed", "Customer Impact": false },
            attachments: [{ asset: "onboardingChecklist", uploadedBy: "henry" }],
          },
          {
            title: "Follow up on stale API tokens",
            description: note(
              "Several integration tokens are months old and still carry scopes their owners may no longer need.",
              "Confirm the last known customer use with support, revoke the safe ones, and record any exception instead of silently extending it.",
            ),
            list: "Follow-up",
            createdBy: "henry",
            assignees: ["henry", "grace"],
            labels: ["Security", "Compliance"],
            dueOffsetDays: 2,
            dueDateSlot: "afternoon",
            fieldValues: { Service: "api-auth", "Maintenance Window": "No window required", "Customer Impact": true },
            comments: [
              { author: "grace", hoursAfterCreation: 5, body: "Support has already confirmed two of these can be revoked this week." },
            ],
          },
          {
            title: "Archive old audit request templates",
            description: note(
              "Retire the audit request templates that still mention removed product concepts.",
              "Leave an archive pointer for existing requests, but make the current pack the only obvious starting point.",
            ),
            list: "Completed",
            createdBy: "grace",
            assignees: ["grace"],
            labels: ["Compliance"],
            dueOffsetDays: -8,
            fieldValues: { Service: "audit-export", "Maintenance Window": "Completed", "Customer Impact": false },
          },
          {
            title: "Write incident communication approval matrix",
            description: note(
              "Define the approver for customer-facing incident language at each severity and scope.",
              "The matrix needs an off-hours path so the incident lead is not waiting for a routine business-hours review.",
            ),
            list: "Planned",
            createdBy: "amelia",
            assignees: ["amelia", "henry"],
            labels: ["Compliance", "Incident"],
            dueOffsetDays: 12,
            fieldValues: { Service: "incident-comms", "Maintenance Window": "No window required", "Customer Impact": false },
            attachments: [{ asset: "apiRolloutPlan", uploadedBy: "amelia" }],
          },
          {
            title: "Track follow-up actions from policy review",
            description: note(
              "The policy review left several small actions without an owner or due date.",
              "Keep them here until each action has moved into the right operational queue and its evidence link is known.",
            ),
            list: "Follow-up",
            createdBy: "grace",
            assignees: ["grace", "henry"],
            labels: ["Compliance"],
            dueOffsetDays: 6,
            fieldValues: { Service: "governance", "Maintenance Window": "No window required", "Customer Impact": false },
          },
        ],
      },
    ],
  };
}

// These denser conversation cards sit alongside the broader board fixtures above. Keeping them
// grouped makes it easy to see which demo boards deliberately exercise overdue work, mentions,
// attachment stacks, and partially completed checklists.
function extraCardsForBoard(boardKey: string): SeedCard[] {
  switch (boardKey) {
    case "platform-delivery":
      return [
        {
          title: "Fix reconnect gaps from dogfooding",
          description: note(
            "Three dogfooding sessions found stale cards after laptops woke from sleep.",
            "Reconcile the workspace list stream before board card events, preserve optimistic edits, and capture a two-tab recording for QA.",
            "Decision needed: whether a failed reconciliation should show a blocking banner or a quiet retry state.",
          ),
          list: "In Progress", createdBy: "ben", assignees: ["ben", "nina"], watchers: ["priya", "omar"],
          labels: ["Issue / Bug", "Feature / Enhancement"], dueOffsetDays: -2, dueDateSlot: "afternoon",
          fieldValues: { Branch: "fix/reconnect-reconciliation", "Billing Hours": 12.75, "Billing Month": seedMonthLabel(), Client: "Northstar" },
          attachments: [
            { asset: "realtimeBoardCover", uploadedBy: "nina", useAsCover: true },
            { asset: "realtimeSyncSymbol", uploadedBy: "ben", useAsCover: false },
            { asset: "architectureRecord", uploadedBy: "ben" },
            { asset: "northstarLogo", uploadedBy: "nina", useAsCover: false },
          ],
          checklists: [{
            title: "Dogfood findings", items: [
              { text: "Reproduce sleep/wake with two board tabs", dueOffsetDays: -3, dueDateSlot: "morning", completedBy: "nina", completedOffsetHours: 8 },
              { text: "Order workspace reconciliation before board replay", dueOffsetDays: -2, dueDateSlot: "afternoon" },
              { text: "Verify optimistic title edits survive reconnect", dueOffsetDays: -1, dueDateSlot: "morning" },
              { text: "Capture Chrome and Safari evidence", dueOffsetDays: 0, dueDateSlot: "endOfWorkDay" },
            ]
          }],
          comments: [
            { author: "nina", hoursAfterCreation: 7, body: "The stale state only appears when a workspace list event lands before the board room rejoins.", mentions: ["ben"] },
            { author: "priya", hoursAfterCreation: 19, body: "Please keep the ordering constraint in a code comment; this will be easy to regress during the transport cleanup.", mentions: ["ben", "omar"], unreadFor: ["omar"] },
          ],
        },
        {
          title: "Write migration rollback guide for customer imports",
          description: note("Turn the import rollback notes into an operator-ready guide.", "Include partial imports, attachment cleanup, retry ownership, and the SQL evidence support should retain."),
          list: "Backlog", createdBy: "omar", assignees: ["omar", "priya"], labels: ["Chore", "Support"], dueOffsetDays: 8,
          fieldValues: { Branch: "docs/import-rollback-guide", "Billing Hours": 4, "Billing Month": seedMonthLabel(), Client: "Orbiflow" },
          attachments: [{ asset: "apiRolloutPlan", uploadedBy: "omar" }, { asset: "retroNotes", uploadedBy: "priya" }],
          comments: [{ author: "amelia", hoursAfterCreation: 5, body: "Add a worked example using an import that fails after attachments are stored.", mentions: ["omar"] }],
        },
      ];
    case "mobile-experience":
      return [
        {
          title: "Triage notification beta feedback",
          description: note("The latest beta produced eleven notes across iOS and Android.", "Group duplicates, confirm which reports are platform-specific, and turn confirmed defects into linked follow-up cards."),
          list: "Awaiting Feedback", createdBy: "nina", assignees: ["nina", "ben"], watchers: ["marcus"], labels: ["Support", "Issue / Bug"], dueOffsetDays: -1, dueDateSlot: "endOfWorkDay",
          fieldValues: { Branch: "chore/beta-notification-triage", "Billing Hours": 6.25, "Billing Month": seedMonthLabel(), Client: "Northstar" },
          attachments: [
            { asset: "mobileNotificationCover", uploadedBy: "nina", useAsCover: true },
            { asset: "northstarLogo", uploadedBy: "nina", useAsCover: false },
            { asset: "releaseTemplate", uploadedBy: "ben" },
          ],
          checklists: [{
            title: "Beta inbox", items: [
              { text: "Merge duplicate missing-title reports", completedBy: "nina", completedOffsetHours: 5 },
              { text: "Retest quiet-hours boundary in Sydney timezone", dueOffsetDays: -1, dueDateSlot: "afternoon" },
              { text: "Confirm badge count after sign-out and sign-in", dueOffsetDays: 0, dueDateSlot: "morning" },
              { text: "Post beta summary for support", dueOffsetDays: 1, dueDateSlot: "afternoon" },
            ]
          }],
          comments: [
            { author: "marcus", hoursAfterCreation: 6, body: "The missing title report is the one customers will notice first. Can we confirm whether it is still reproducible?", mentions: ["nina"] },
            { author: "ben", hoursAfterCreation: 15, body: "I have the timezone fix locally; I still need a Sydney-device retest before opening the PR.", mentions: ["nina"], unreadFor: ["nina"] },
          ],
        },
        {
          title: "Prototype compact checklist controls on small screens",
          description: note("Long checklist cards currently push ownership and due dates below the fold.", "Prototype a compact row that retains completion, assignee, and overdue status at 360px."),
          list: "Wishlist", createdBy: "ben", assignees: ["ben"], labels: ["Feature / Enhancement"], dueOffsetDays: 13,
          fieldValues: { Branch: "spike/mobile-checklist-density", "Billing Hours": 3.5, "Billing Month": seedMonthLabel(1), Client: "Sprintforge" },
          attachments: [{ asset: "compactMobileChecklist", uploadedBy: "ben", useAsCover: true }],
        },
      ];
    case "production-reliability":
      return [
        {
          title: "Investigate attachment worker memory spikes",
          description: note("The attachment worker crossed the memory alert threshold three times overnight.", "Correlate source mime types, cover generation, and concurrent thumbnail work before changing limits."),
          list: "Implementing", createdBy: "grace", assignees: ["grace", "omar"], watchers: ["henry", "amelia"], labels: ["Incident", "Infrastructure"], dueOffsetDays: -2, dueDateSlot: "morning",
          fieldValues: { Service: "attachment-pipeline", "Maintenance Window": "Emergency if threshold repeats", "Customer Impact": true },
          attachments: [
            { asset: "workerIncidentCover", uploadedBy: "grace", useAsCover: true },
            { asset: "apiRolloutPlan", uploadedBy: "grace" },
            { asset: "architectureRecord", uploadedBy: "omar" },
          ],
          checklists: [{
            title: "Incident investigation", items: [
              { text: "Correlate memory peaks with image mime type", dueOffsetDays: -2, completedBy: "omar", completedOffsetHours: 5 },
              { text: "Compare cover and thumbnail concurrency", dueOffsetDays: -1 },
              { text: "Run a bounded replay with production-sized images", dueOffsetDays: 0 },
              { text: "Write mitigation and rollback thresholds", dueOffsetDays: 1 },
            ]
          }],
          comments: [
            { author: "henry", hoursAfterCreation: 3, body: "The spikes line up with cover generation, but only when a PDF upload is in the same batch.", mentions: ["grace", "omar"] },
            { author: "omar", hoursAfterCreation: 10, body: "I can reproduce the pattern at concurrency eight. Concurrency four stays below the alert threshold.", mentions: ["grace"], unreadFor: ["grace"] },
          ],
        },
        {
          title: "Rehearse cross-region database failover",
          description: note("Run the quarterly failover rehearsal in the staging topology.", "Capture application recovery, websocket reconnect behaviour, and the exact point at which writes are reopened."),
          list: "Planned", createdBy: "henry", assignees: ["henry", "grace"], labels: ["Infrastructure", "Automation"], dueOffsetDays: 10,
          fieldValues: { Service: "postgres", "Maintenance Window": "Sun 02:00 UTC", "Customer Impact": false },
          attachments: [{ asset: "releaseTemplate", uploadedBy: "henry" }, { asset: "onboardingChecklist", uploadedBy: "grace" }],
        },
      ];
    case "access-and-compliance":
      return [
        {
          title: "Close access review evidence gaps",
          description: note("Four access decisions are missing reviewer evidence or a support confirmation.", "Backfill the evidence without changing the original decision timestamps, then have a second reviewer sign off."),
          list: "Follow-up", createdBy: "henry", assignees: ["henry", "grace"], watchers: ["amelia"], labels: ["Compliance", "Security"], dueOffsetDays: -2, dueDateSlot: "endOfWorkDay",
          fieldValues: { Service: "identity", "Maintenance Window": "No window required", "Customer Impact": false },
          attachments: [
            { asset: "accessReviewCover", uploadedBy: "grace", useAsCover: true },
            { asset: "onboardingChecklist", uploadedBy: "henry" },
            { asset: "architectureRecord", uploadedBy: "grace" },
          ],
          checklists: [{
            title: "Missing evidence", items: [
              { text: "Attach source query for dormant admins", completedBy: "henry", completedOffsetHours: 4 },
              { text: "Record support confirmation for two revocations", dueOffsetDays: -2 },
              { text: "Add reviewer identity to exception decision", dueOffsetDays: -1 },
              { text: "Complete independent sign-off", dueOffsetDays: 0 },
            ]
          }],
          comments: [
            { author: "amelia", hoursAfterCreation: 5, body: "Do not rewrite the original timestamps; add the evidence as a follow-up entry so the audit trail stays honest.", mentions: ["henry", "grace"] },
            { author: "grace", hoursAfterCreation: 14, body: "Support confirmed both revocations. I am waiting on the reviewer identity for the exception row.", mentions: ["henry"], unreadFor: ["henry"] },
          ],
        },
        {
          title: "Prepare least-privilege workshop examples",
          description: note("Build three realistic permission scenarios for the next admin workshop.", "Include an organisation admin, a workspace member, and a cross-organisation board guest."),
          list: "Planned", createdBy: "grace", assignees: ["grace", "henry"], labels: ["Compliance", "Security"], dueOffsetDays: 9,
          fieldValues: { Service: "permissions", "Maintenance Window": "No window required", "Customer Impact": false },
          attachments: [
            { asset: "accessReviewSymbol", uploadedBy: "grace", useAsCover: true },
            { asset: "onboardingChecklist", uploadedBy: "grace" },
            { asset: "releaseTemplate", uploadedBy: "henry" },
          ],
          comments: [{ author: "amelia", hoursAfterCreation: 7, body: "Use Maya’s board guest account for the third scenario so the workshop matches the product demo.", mentions: ["grace"] }],
        },
      ];
    default:
      return [];
  }
}

function positionForIndex(index: number): string {
  return String((index + 1) * 1000);
}

function seedStringHash(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}

function realisticChecklistItems(
  checklist: SeedChecklist,
  context: string,
  cardAssigneeCount: number,
): SeedChecklistItem[] {
  if (checklist.items.length === 0) return [];
  const hash = seedStringHash(`${context}:${checklist.title}`);
  const assignableIndexes = checklist.items.flatMap((item, index) => item.assignee === undefined ? [] : [index]);
  // Authored item ownership represents a deliberate handoff. Never duplicate a sole card owner,
  // and cap jointly owned cards at two delegated checklist items as a defensive seed invariant.
  const assignedIndexes = new Set(cardAssigneeCount <= 1 ? [] : assignableIndexes.slice(0, 2));

  const completionSeeds = checklist.items.filter((item) => item.completedBy !== undefined);
  const completedIndexes = new Map<number, SeedChecklistItem>();
  const start = (hash >>> 4) % checklist.items.length;
  for (let offset = 0; offset < completionSeeds.length; offset += 1) {
    let index = (start + offset * 2) % checklist.items.length;
    while (completedIndexes.has(index)) index = (index + 1) % checklist.items.length;
    completedIndexes.set(index, completionSeeds[offset]!);
  }

  return checklist.items.map((item, index) => {
    const completion = completedIndexes.get(index);
    return {
      ...item,
      assignee: assignedIndexes.has(index) ? item.assignee : undefined,
      completedBy: completion?.completedBy,
      completedOffsetHours: completion?.completedOffsetHours,
    };
  });
}

function startOfToday(): Date {
  const now = new Date();
  // Seed history should resemble human activity, not a scheduler firing on an hourly boundary.
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 13, 27, 0));
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function addHours(value: Date, hours: number): Date {
  const approximateTime = value.getTime() + hours * 60 * 60 * 1000;
  const salt = Math.abs(Math.trunc(value.getTime() / 60_000) + Math.round(hours * 100));
  const minuteJitter = 3 + salt % 23;
  const secondJitter = 7 + salt * 7 % 47;
  const result = new Date(approximateTime + minuteJitter * 60_000 + secondJitter * 1000);
  if (result.getUTCMinutes() === 0) result.setUTCMinutes(7);
  return result;
}

function addMinutes(value: Date, minutes: number): Date {
  const result = new Date(value.getTime() + minutes * 60 * 1000);
  if (result.getUTCMinutes() === 0) result.setUTCMinutes(7);
  return result;
}

function formatLocalDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function seedCommentBody(comment: SeedComment, userIdByKey: Map<SeedUserKey, string>): string {
  if (!comment.mentions?.length) return comment.body;
  const mentions = comment.mentions.map((userKey) => {
    const user = seedUserByKey.get(userKey);
    const userId = userIdByKey.get(userKey);
    if (!user || !userId) throw new Error(`Missing seeded mention user '${userKey}'.`);
    return `@[${user.displayName}](kanera-user:${userId})`;
  });
  return `${comment.body}\n\n${mentions.join(" ")}`;
}

function isCompletedList(listName: string): boolean {
  return listName === "Complete" || listName === "Completed" || listName === "Done";
}

// recordActivity always stamps the current time, which is correct for live routes but wrong for
// backfilled seed history. This writes the audit row at the real historical moment so a card's
// activity feed (ordered by createdAt) reads oldest-first: created, then each move, then discussion.
async function insertSeedActivity(
  tx: Tx,
  input: {
    boardId: string;
    workspaceId: string;
    actorId: string;
    entityType: ActivityEntityType;
    entityId: string;
    action: ActivityAction;
    payload: Record<string, unknown>;
    createdAt: Date;
  },
): Promise<void> {
  await tx.insert(activityEvents).values({
    boardId: input.boardId,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    payload: input.payload,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

// Given the list a card currently sits in, return the ordered lists it plausibly passed through,
// beginning at its origin list and ending at the current list. A card in the first flow list (a
// fresh idea) returns a single-entry path and therefore gets no movement history.
function seedMovementPath(
  listName: string,
  flow: readonly string[],
  sideEntries: Readonly<Record<string, string>>,
): string[] {
  const flowIndex = flow.indexOf(listName);
  if (flowIndex >= 0) return flow.slice(0, flowIndex + 1);
  // A side-state (e.g. "Waiting on Others") is reached from a point on the happy path, then sat in.
  const feeder = sideEntries[listName];
  if (feeder) {
    const feederIndex = flow.indexOf(feeder);
    if (feederIndex >= 0) return [...flow.slice(0, feederIndex + 1), listName];
  }
  return [listName];
}

async function insertSeedNotes(input: {
  tx: Tx;
  storage: StorageProvider | null;
  clientId: string;
  uploadedKeys: string[];
  assetCache: Map<AssetKey, Buffer>;
  workspaceId: string;
  boardId: string | null;
  parentNoteId: string | null;
  noteSeeds: SeedNote[];
  userIdByKey: Map<SeedUserKey, string>;
  baseCreatedAt: Date;
}): Promise<SeedNotesResult> {
  const result: SeedNotesResult = { notes: 0, attachments: 0 };
  for (const [index, noteSeed] of input.noteSeeds.entries()) {
    const createdAt = addHours(input.baseCreatedAt, index + 1);
    const [noteRow] = await input.tx
      .insert(notes)
      .values({
        workspaceId: input.workspaceId,
        boardId: input.boardId,
        parentNoteId: input.parentNoteId,
        scope: noteSeed.scope ?? "team",
        ownerId: input.userIdByKey.get(noteSeed.owner)!,
        lastEditedById: input.userIdByKey.get(noteSeed.owner)!,
        title: noteSeed.title,
        content: noteSeed.content,
        icon: noteSeed.icon ?? null,
        position: positionForIndex(index),
        createdAt,
        lastEditedAt: createdAt,
        updatedAt: createdAt,
      })
      .returning();
    result.notes += 1;

    for (const [attachmentIndex, attachmentSeed] of (noteSeed.attachments ?? []).entries()) {
      if (!input.storage) throw new Error("Storage provider was not initialized.");
      await createNoteAttachmentRow({
        tx: input.tx,
        storage: input.storage,
        clientId: input.clientId,
        uploadedKeys: input.uploadedKeys,
        assetCache: input.assetCache,
        noteId: noteRow!.id,
        uploadedById: input.userIdByKey.get(attachmentSeed.uploadedBy)!,
        asset: attachmentSeed.asset,
        createdAt: addHours(createdAt, attachmentIndex + 1),
      });
      result.attachments += 1;
    }

    if (noteSeed.children?.length) {
      const childResult = await insertSeedNotes({
        ...input,
        parentNoteId: noteRow!.id,
        noteSeeds: noteSeed.children,
        baseCreatedAt: createdAt,
      });
      result.notes += childResult.notes;
      result.attachments += childResult.attachments;
    }
  }
  return result;
}

function attachmentAssetPath(asset: AssetKey): string {
  return path.join(REPO_ROOT, "dev-db-seed-content", "attachments", ...ATTACHMENT_ASSETS[asset].relativePath);
}

function avatarAssetPath(user: SeedUser): string {
  // Gender is part of the asset path so adding a seed user requires an explicit portrait choice
  // instead of silently falling back to a randomly generated, potentially mismatched avatar.
  return path.join(REPO_ROOT, "dev-db-seed-content", "avatars", user.gender, user.avatarFileName);
}

async function assertBlankDatabase(): Promise<void> {
  const checks = await Promise.all([
    db.select({ id: clients.id }).from(clients).limit(1),
    db.select({ id: users.id }).from(users).limit(1),
    db.select({ id: workspaces.id }).from(workspaces).limit(1),
    db.select({ id: boards.id }).from(boards).limit(1),
    db.select({ id: cards.id }).from(cards).limit(1),
    db.select({ id: comments.id }).from(comments).limit(1),
  ]);

  const occupiedTables = ["client", "user", "workspace", "board", "card", "comment"].filter(
    (_name, index) => checks[index]!.length > 0,
  );

  if (occupiedTables.length > 0) {
    throw new Error(
      `Seed script expects a blank migrated database. Found rows in: ${occupiedTables.join(", ")}. Reset the DB before seeding.`,
    );
  }
}

async function loadAssetBuffer(asset: AssetKey, cache: Map<AssetKey, Buffer>): Promise<Buffer> {
  const existing = cache.get(asset);
  if (existing) return existing;
  const buffer = await readFile(attachmentAssetPath(asset));
  cache.set(asset, buffer);
  return buffer;
}

async function setSeedUserAvatar(input: {
  tx: Tx;
  storage: StorageProvider;
  clientId: string;
  userId: string;
  userSeed: SeedUser;
  uploadedKeys: string[];
}): Promise<void> {
  const buffer = await readFile(avatarAssetPath(input.userSeed));
  const fileKey = avatarStorageKey(input.userId, "webp");
  await input.storage.put(fileKey, buffer, "image/webp");
  input.uploadedKeys.push(fileKey);

  await input.tx
    .update(users)
    .set({ avatarUrl: unsignedMediaUrl(input.clientId, fileKey) })
    .where(eq(users.id, input.userId));
}

async function seedInternalLinkDemos(tx: Tx, workspaceId: string): Promise<number> {
  const noteRows = await tx.select().from(notes).where(eq(notes.workspaceId, workspaceId));
  const boardRows = await tx.select().from(boards).where(eq(boards.workspaceId, workspaceId));
  const cardRows = await tx
    .select({ card: cards, board: boards })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(eq(boards.workspaceId, workspaceId));

  const noteByTitle = new Map(noteRows.map((row) => [row.title, row]));
  const boardByName = new Map(boardRows.map((row) => [row.name, row]));
  const cardByTitle = new Map(cardRows.map((row) => [row.card.title, row]));
  const rows: (typeof internalLinks.$inferInsert)[] = [];

  async function linkCardToNote(cardTitle: string, noteTitle: string) {
    const row = cardByTitle.get(cardTitle);
    const targetNote = noteByTitle.get(noteTitle);
    if (!row || !targetNote) return;
    const href = targetNote.boardId
      ? `/b/${targetNote.boardId}?view=notes&noteId=${targetNote.id}`
      : `/w/${targetNote.workspaceId}/notes?noteId=${targetNote.id}`;
    await tx.update(cards).set({
      description: note(row.card.description ?? "", `Related note: ${href}`),
      updatedAt: new Date(),
    }).where(eq(cards.id, row.card.id));
    rows.push({ workspaceId, sourceType: "card", sourceId: row.card.id, targetType: "note", targetId: targetNote.id });
  }

  async function linkNoteToCard(noteTitle: string, cardTitle: string) {
    const sourceNote = noteByTitle.get(noteTitle);
    const row = cardByTitle.get(cardTitle);
    if (!sourceNote || !row) return;
    const href = cardPath(row.card.organisationKey, row.card.key);
    await tx.update(notes).set({
      content: note(sourceNote.content, `Related card: ${href}`),
      updatedAt: new Date(),
    }).where(eq(notes.id, sourceNote.id));
    rows.push({ workspaceId, sourceType: "note", sourceId: sourceNote.id, targetType: "card", targetId: row.card.id });
  }

  async function linkNoteToBoard(noteTitle: string, boardName: string) {
    const sourceNote = noteByTitle.get(noteTitle);
    const targetBoard = boardByName.get(boardName);
    if (!sourceNote || !targetBoard) return;
    const href = `/b/${targetBoard.id}`;
    await tx.update(notes).set({
      content: note(sourceNote.content, `Related board: ${href}`),
      updatedAt: new Date(),
    }).where(eq(notes.id, sourceNote.id));
    rows.push({ workspaceId, sourceType: "note", sourceId: sourceNote.id, targetType: "board", targetId: targetBoard.id });
  }

  await linkCardToNote("Roll out project templates to new workspaces", "Project Template Rollout Plan");
  await linkNoteToCard("Project Template Rollout Plan", "Roll out project templates to new workspaces");
  await linkNoteToBoard("Release Process", "Platform Delivery");
  await linkCardToNote("Prepare autumn campaign launch", "Autumn Campaign Launch Plan");
  await linkNoteToCard("Autumn Campaign Launch Plan", "Prepare autumn campaign launch");

  if (rows.length === 0) return 0;
  await tx.insert(internalLinks).values(rows).onConflictDoNothing();
  return rows.length;
}

function fieldValueUpdate(fieldName: string, fieldType: string, value: SeedFieldValue, optionIdByFieldAndLabel: Map<string, Map<string, string>>) {
  const base = { valueText: null, valueNumber: null, valueCheckbox: null, valueOptionIds: null } as {
    valueText: string | null;
    valueNumber: string | null;
    valueCheckbox: boolean | null;
    valueOptionIds: string[] | null;
  };
  if (fieldType === "text") return { ...base, valueText: String(value) };
  if (fieldType === "number") return { ...base, valueNumber: String(value) };
  if (fieldType === "checkbox") return { ...base, valueCheckbox: Boolean(value) };
  if (fieldType === "select") {
    if (typeof value !== "string") throw new Error(`Select field '${fieldName}' needs an option label string.`);
    const optionId = optionIdByFieldAndLabel.get(fieldName)?.get(value);
    if (!optionId) throw new Error(`Missing option '${value}' for select field '${fieldName}'.`);
    return { ...base, valueOptionIds: [optionId] };
  }
  throw new Error(`Unsupported seed custom field type '${fieldType}' for '${fieldName}'.`);
}

async function createNoteAttachmentRow(input: {
  tx: Tx;
  storage: StorageProvider;
  clientId: string;
  uploadedKeys: string[];
  assetCache: Map<AssetKey, Buffer>;
  noteId: string;
  uploadedById: string;
  asset: AssetKey;
  createdAt: Date;
}) {
  const assetMeta = ATTACHMENT_ASSETS[input.asset];
  const fileName = path.basename(attachmentAssetPath(input.asset));
  const extension = path.extname(fileName).slice(1);
  const buffer = await loadAssetBuffer(input.asset, input.assetCache);
  const fileKey = noteAttachmentStorageKey(input.noteId, extension);
  await input.storage.put(fileKey, buffer, assetMeta.mimeType);
  input.uploadedKeys.push(fileKey);

  await input.tx.insert(noteAttachments).values({
    noteId: input.noteId,
    clientId: input.clientId,
    uploadedById: input.uploadedById,
    fileName,
    mimeType: assetMeta.mimeType,
    byteSize: buffer.byteLength,
    fileKey,
    url: unsignedMediaUrl(input.clientId, fileKey)!,
    source: "attachment",
    createdAt: input.createdAt,
  });
}

async function createAttachmentRow(input: {
  tx: Tx;
  storage: StorageProvider;
  clientId: string;
  uploadedKeys: string[];
  assetCache: Map<AssetKey, Buffer>;
  cardId: string;
  uploadedById: string;
  asset: AssetKey;
  createdAt: Date;
  shouldGenerateCover: boolean;
}) {
  const assetMeta = ATTACHMENT_ASSETS[input.asset];
  const fileName = path.basename(attachmentAssetPath(input.asset));
  const extension = path.extname(fileName).slice(1);
  const buffer = await loadAssetBuffer(input.asset, input.assetCache);
  const fileKey = cardAttachmentStorageKey(input.cardId, extension);
  await input.storage.put(fileKey, buffer, assetMeta.mimeType);
  input.uploadedKeys.push(fileKey);

  let thumbnailUrl: string | null = null;
  let thumbnailFileKey: string | null = null;
  let coverImageUrl: string | null = null;
  let coverImageFileKey: string | null = null;
  let coverImageWidth: number | null = null;
  let coverImageHeight: number | null = null;
  let coverImageColor: string | null = null;

  if (isProcessableImage(assetMeta.mimeType)) {
    const thumbnail = await generateThumbnail(buffer, assetMeta.mimeType);
    thumbnailFileKey = attachmentThumbnailStorageKey(fileKey, thumbnail.ext);
    await input.storage.put(thumbnailFileKey, thumbnail.buffer, thumbnail.mimeType);
    input.uploadedKeys.push(thumbnailFileKey);
    thumbnailUrl = unsignedMediaUrl(input.clientId, thumbnailFileKey);
    coverImageColor = thumbnail.dominantColor;

    if (input.shouldGenerateCover) {
      const cover = await generateCoverImage(buffer, assetMeta.mimeType);
      coverImageFileKey = attachmentCoverStorageKey(fileKey, cover.ext);
      await input.storage.put(coverImageFileKey, cover.buffer, cover.mimeType);
      input.uploadedKeys.push(coverImageFileKey);
      coverImageUrl = unsignedMediaUrl(input.clientId, coverImageFileKey);
      coverImageWidth = cover.width;
      coverImageHeight = cover.height;
    }
  }

  const [attachment] = await input.tx
    .insert(cardAttachments)
    .values({
      cardId: input.cardId,
      clientId: input.clientId,
      uploadedById: input.uploadedById,
      fileName,
      mimeType: assetMeta.mimeType,
      byteSize: buffer.byteLength,
      fileKey,
      url: unsignedMediaUrl(input.clientId, fileKey)!,
      thumbnailUrl,
      thumbnailFileKey,
      coverImageUrl,
      coverImageFileKey,
      coverImageWidth,
      coverImageHeight,
      coverImageColor,
      source: "attachment",
      commentId: null,
      createdAt: input.createdAt,
    })
    .returning();

  return attachment!;
}

export async function seedDatabase(options: SeedDatabaseOptions = {}): Promise<SeedDatabaseResult> {
  if (options.requireBlankDatabase ?? true) await assertBlankDatabase();

  const passwordHash = await hashPassword(options.password ?? DEV_SEED_SHARED_PASSWORD);
  const workspaceSeeds = buildWorkspaceSeeds();
  const summary: SeedSummary = {
    users: 0,
    workspaces: 0,
    boards: 0,
    cards: 0,
    checklists: 0,
    checklistItems: 0,
    comments: 0,
    separators: 0,
    attachments: 0,
    cardCovers: 0,
    cardMoves: 0,
    notes: 0,
    internalLinks: 0,
    mentions: 0,
    notifications: 0,
  };
  const uploadedKeys: string[] = [];
  const guestUploadedKeys: string[] = [];
  const assetCache = new Map<AssetKey, Buffer>();
  let storage: StorageProvider | null = null;
  let guestStorage: StorageProvider | null = null;
  let primaryClientId: string | null = null;
  let guestClientId: string | null = null;

  try {
    await db.transaction(async (tx) => {
      const storageConfig = getConfiguredS3StorageConfig() ?? { kind: "local" as const };
      const [client] = await tx
        .insert(clients)
        .values({
          name: "Happen Software",
          storageConfig,
          analyticsExcluded: options.analyticsExcluded ?? false,
          // Keep hosted dev seeds aligned with real hosted signup: the seeded org starts as a
          // trialing Pro org so Account settings can exercise trial, upgrade, and cancel flows.
          ...(options.paid
            ? {
              pushEnabled: true,
              plan: "paid" as const,
              billingStatus: "active" as const,
              // Paid subscriptions enforce purchased capacity. Leave room for every seeded member
              // plus one paid cross-organisation guest without requiring a Stripe-backed increase.
              seatLimit: USER_SEEDS.length + 1,
            }
            : env.KANERA_DEPLOYMENT_MODE === "hosted"
            ? {
              pushEnabled: true,
              plan: "paid" as const,
              billingStatus: "trialing" as const,
              currentPeriodEnd: new Date(Date.now() + env.HOSTED_TRIAL_DAYS * 86_400_000),
              // Cover seeded users if this account later converts to a paid subscription.
              seatLimit: Math.max(1, USER_SEEDS.length),
            }
            : {}),
        })
        .returning();
      primaryClientId = client!.id;

      storage = createStorageForConfig(client!.id, storageConfig);

      const userIdByKey = new Map<SeedUserKey, string>();
      const userTimezoneByKey = new Map<SeedUserKey, string>();
      const baseDate = startOfToday();
      for (const userSeed of USER_SEEDS) {
        const [user] = await tx
          .insert(users)
          .values({
            clientId: client!.id,
            activeClientId: client!.id,
            email: userSeed.email,
            passwordHash,
            displayName: userSeed.displayName,
            timezone: userSeed.timezone,
          })
          .returning();
        await tx.insert(clientMembers).values({
          clientId: client!.id,
          userId: user!.id,
          clientRole: userSeed.clientRole,
        });
        await setSeedUserAvatar({
          tx,
          storage,
          clientId: client!.id,
          userId: user!.id,
          userSeed,
          uploadedKeys,
        });
        userIdByKey.set(userSeed.key, user!.id);
        userTimezoneByKey.set(userSeed.key, userSeed.timezone);
        summary.users += 1;
      }
      const primaryOwnerSeed = USER_SEEDS.find((userSeed) => userSeed.clientRole === "owner");
      if (primaryOwnerSeed) {
        await tx.update(clients).set({ createdByUserId: userIdByKey.get(primaryOwnerSeed.key)! }).where(eq(clients.id, client!.id));
      }

      // A separate client makes Maya a real cross-organisation guest. Her own workspace keeps
      // normal sign-in from sending her through onboarding before she can open the shared board.
      const guestStorageConfig = storageConfig;
      const [guestClient] = await tx
        .insert(clients)
        .values({
          name: "Maya Chen Consulting",
          storageConfig: guestStorageConfig,
          analyticsExcluded: options.analyticsExcluded ?? false,
          ...(options.paid
            ? {
              pushEnabled: true,
              plan: "paid" as const,
              billingStatus: "active" as const,
              seatLimit: 1,
            }
            : {}),
        })
        .returning();
      guestClientId = guestClient!.id;
      guestStorage = createStorageForConfig(guestClient!.id, guestStorageConfig);
      const [guestUser] = await tx
        .insert(users)
        .values({
          clientId: guestClient!.id,
          activeClientId: guestClient!.id,
          email: GUEST_USER_SEED.email,
          passwordHash,
          displayName: GUEST_USER_SEED.displayName,
          timezone: GUEST_USER_SEED.timezone,
        })
        .returning();
      await tx.insert(clientMembers).values({
        clientId: guestClient!.id,
        userId: guestUser!.id,
        clientRole: GUEST_USER_SEED.clientRole,
      });
      await tx.update(clients).set({ createdByUserId: guestUser!.id }).where(eq(clients.id, guestClient!.id));
      await setSeedUserAvatar({
        tx,
        storage: guestStorage,
        clientId: guestClient!.id,
        userId: guestUser!.id,
        userSeed: GUEST_USER_SEED,
        uploadedKeys: guestUploadedKeys,
      });
      userIdByKey.set(GUEST_USER_SEED.key, guestUser!.id);
      userTimezoneByKey.set(GUEST_USER_SEED.key, GUEST_USER_SEED.timezone);
      summary.users += 1;

      const guestWorkspaceCreatedAt = addDays(baseDate, -3);
      const [guestWorkspace] = await tx
        .insert(workspaces)
        .values({
          clientId: guestClient!.id,
          name: "Maya's Workspace",
          icon: "briefcase",
          accentColor: "violet",
          createdAt: guestWorkspaceCreatedAt,
          updatedAt: guestWorkspaceCreatedAt,
        })
        .returning();
      await tx.insert(workspaceMembers).values({
        workspaceId: guestWorkspace!.id,
        userId: guestUser!.id,
        role: "admin",
        addedAt: addHours(guestWorkspaceCreatedAt, 1),
      });
      summary.workspaces += 1;

      const guestListRows = await tx
        .insert(lists)
        .values(
          [
            { name: "To Do", icon: "circle" },
            { name: "Doing", icon: "progress" },
            { name: "Waiting", icon: "clock-pause" },
            { name: "Done", icon: "circle-check" },
          ].map((listSeed, index) => ({
            workspaceId: guestWorkspace!.id,
            name: listSeed.name,
            icon: listSeed.icon,
            color: null,
            position: positionForIndex(index),
            createdAt: addHours(guestWorkspaceCreatedAt, 2),
            updatedAt: addHours(guestWorkspaceCreatedAt, 2),
          })),
        )
        .returning();
      const guestListByName = new Map(guestListRows.map((row) => [row.name, row]));

      const guestBoardCreatedAt = addHours(guestWorkspaceCreatedAt, 3);
      const [guestBoard] = await tx
        .insert(boards)
        .values({
          workspaceId: guestWorkspace!.id,
          name: "Todo",
          description: "A lightweight board for Maya's personal tasks and follow-ups.",
          icon: "list-check",
          iconColor: "violet",
          position: positionForIndex(0),
          createdAt: guestBoardCreatedAt,
          updatedAt: guestBoardCreatedAt,
        })
        .returning();
      summary.boards += 1;

      // Materialize Maya's own board membership too; workspace access is sufficient for runtime
      // access, but seeded board rows should mirror the rest of the demo data and board picker.
      await tx.insert(boardMembers).values({
        boardId: guestBoard!.id,
        userId: guestUser!.id,
        role: "editor",
        pinned: true,
        addedAt: addHours(guestBoardCreatedAt, 1),
      });

      await recordActivity(tx, {
        boardId: guestBoard!.id,
        workspaceId: guestWorkspace!.id,
        actorId: guestUser!.id,
        entityType: "board",
        entityId: guestBoard!.id,
        action: "created",
        payload: { name: "Todo" },
      });

      const guestCards = [
        {
          title: "Review shared Mobile Experience board",
          description: "Check the guest-access demo board and leave notes on anything that needs follow-up.",
          list: "To Do",
          dueOffsetDays: 1,
          dueDateSlot: "morning" as const,
        },
        {
          title: "Draft client kickoff agenda",
          description: "Outline goals, owners, open questions, and next steps before the first call.",
          list: "Doing",
          dueOffsetDays: 2,
          dueDateSlot: "afternoon" as const,
        },
        {
          title: "Send contract follow-up",
          description: "Waiting on the signed SOW and billing contact confirmation.",
          list: "Waiting",
          dueOffsetDays: 4,
          dueDateSlot: "endOfWorkDay" as const,
        },
        {
          title: "Set up Kanera seed account",
          description: "Confirm the external guest account has its own workspace plus access to the shared board.",
          list: "Done",
          dueOffsetDays: -1,
          dueDateSlot: "afternoon" as const,
        },
      ];

      const guestCardCountsByList = new Map<string, number>();
      const guestCardIdentities = await allocateCardKeys(tx, guestWorkspace!.id, guestCards.length);
      for (const [cardIndex, cardSeed] of guestCards.entries()) {
        const listRow = guestListByName.get(cardSeed.list);
        if (!listRow) throw new Error(`Missing list '${cardSeed.list}' in Maya's workspace.`);

        const nextListCount = guestCardCountsByList.get(cardSeed.list) ?? 0;
        guestCardCountsByList.set(cardSeed.list, nextListCount + 1);
        const cardCreatedAt = addHours(guestBoardCreatedAt, 2 + cardIndex);
        const [card] = await tx
          .insert(cards)
          .values({
            ...guestCardIdentities[cardIndex]!,
            listId: listRow.id,
            boardId: guestBoard!.id,
            title: cardSeed.title,
            description: cardSeed.description,
            position: positionForIndex(nextListCount),
            dueDateLocalDate: formatLocalDate(addDays(baseDate, cardSeed.dueOffsetDays)),
            dueDateSlot: cardSeed.dueDateSlot,
            dueDateTimezone: GUEST_USER_SEED.timezone,
            createdById: guestUser!.id,
            completedAt: null,
            coverAttachmentId: null,
            createdAt: cardCreatedAt,
            updatedAt: cardCreatedAt,
          })
          .returning();
        summary.cards += 1;

        await tx.insert(cardAssignees).values({
          cardId: card!.id,
          userId: guestUser!.id,
          assignedAt: addHours(cardCreatedAt, 1),
        });

        await recordActivity(tx, {
          boardId: guestBoard!.id,
          workspaceId: guestWorkspace!.id,
          actorId: guestUser!.id,
          entityType: "card",
          entityId: card!.id,
          action: "created",
          payload: { title: cardSeed.title, listId: listRow.id },
        });
      }

      const standaloneCreatedAt = addDays(baseDate, -2);
      const standaloneName = "Launch Checklist";
      const [standaloneWorkspace] = await tx
        .insert(workspaces)
        .values({
          clientId: client!.id,
          name: standaloneName,
          kind: "board",
          icon: "clipboard-check",
          accentColor: "teal",
          createdAt: standaloneCreatedAt,
          updatedAt: standaloneCreatedAt,
        })
        .returning();
      await tx.insert(workspaceMembers).values({
        workspaceId: standaloneWorkspace!.id,
        userId: userIdByKey.get("amelia")!,
        role: "admin",
        addedAt: addHours(standaloneCreatedAt, 1),
      });
      const standaloneListRows = await tx.insert(lists).values(
        [
          { name: "To do", icon: "circle" },
          { name: "In progress", icon: "progress" },
          { name: "Done", icon: "circle-check" },
        ].map((listSeed, index) => ({
          workspaceId: standaloneWorkspace!.id,
          name: listSeed.name,
          icon: listSeed.icon,
          position: positionForIndex(index),
          createdAt: addHours(standaloneCreatedAt, 2),
          updatedAt: addHours(standaloneCreatedAt, 2),
        })),
      ).returning();
      const standaloneListByName = new Map(standaloneListRows.map((row) => [row.name, row]));
      const standaloneCustomFields = [
        { name: "Release version", icon: "tag", type: "text" as const },
        { name: "Rollout percentage", icon: "percentage", type: "number" as const },
        { name: "Go / no-go approved", icon: "circle-check", type: "checkbox" as const },
      ];
      const standaloneCustomFieldRows = await tx.insert(customFields).values(
        standaloneCustomFields.map((field, index) => ({
          workspaceId: standaloneWorkspace!.id,
          name: field.name,
          icon: field.icon,
          type: field.type,
          position: positionForIndex(index),
          createdAt: addHours(standaloneCreatedAt, 2),
          updatedAt: addHours(standaloneCreatedAt, 2),
        })),
      ).returning();
      const standaloneCustomFieldByName = new Map(standaloneCustomFieldRows.map((row) => [row.name, row]));
      const standaloneLabels: SeedLabel[] = [
        { name: "Launch blocker", color: "red" },
        { name: "Pre-launch", color: "violet" },
        { name: "Launch day", color: "teal" },
        { name: "Communications", color: "blue" },
        { name: "Post-launch", color: "orange" },
      ];
      const standaloneLabelRows = await tx.insert(cardLabels).values(
        standaloneLabels.map((label, index) => ({
          workspaceId: standaloneWorkspace!.id,
          name: label.name,
          color: label.color,
          position: positionForIndex(index),
          createdAt: addHours(standaloneCreatedAt, 2),
          updatedAt: addHours(standaloneCreatedAt, 2),
        })),
      ).returning();
      const standaloneLabelByName = new Map(standaloneLabelRows.map((row) => [row.name, row]));
      const [standaloneBoard] = await tx
        .insert(boards)
        .values({
          workspaceId: standaloneWorkspace!.id,
          name: standaloneName,
          description: "Final launch readiness checks for the Kanera public release.",
          icon: "clipboard-check",
          iconColor: "teal",
          position: positionForIndex(0),
          createdAt: addHours(standaloneCreatedAt, 3),
          updatedAt: addHours(standaloneCreatedAt, 3),
        })
        .returning();
      // The migration runs before this seed, so it cannot backfill boards created here. Use the
      // production helper to keep every organisation owner/admin pinned on the standalone board.
      await seedBoardMembersFromWorkspace(tx, standaloneBoard!.id, standaloneWorkspace!.id, userIdByKey.get("amelia")!);
      await recordActivity(tx, {
        boardId: standaloneBoard!.id,
        workspaceId: standaloneWorkspace!.id,
        actorId: userIdByKey.get("amelia")!,
        entityType: "board",
        entityId: standaloneBoard!.id,
        action: "created",
        payload: { name: standaloneName },
      });
      summary.workspaces += 1;
      summary.boards += 1;

      const standaloneCards: SeedCard[] = [
        {
          title: "Run final production smoke test",
          description: "Verify sign-up, workspace creation, card editing, realtime updates, and sign-out against production.",
          list: "In progress",
          createdBy: "amelia",
          assignees: ["amelia"],
          labels: ["Launch blocker", "Launch day"],
          dueOffsetDays: 0,
          dueDateSlot: "morning",
          fieldValues: { "Release version": "1.0.0", "Rollout percentage": 100, "Go / no-go approved": false },
          checklists: [{
            title: "Critical paths",
            items: [
              { text: "Create an account and complete onboarding", completedBy: "amelia", completedOffsetHours: 2 },
              { text: "Create, move, and assign a card", completedBy: "amelia", completedOffsetHours: 3 },
              { text: "Confirm updates appear in a second browser", dueOffsetDays: 0, dueDateSlot: "morning" },
              { text: "Verify refresh-token sign-out", dueOffsetDays: 0, dueDateSlot: "afternoon" },
            ],
          }],
          comments: [{ author: "amelia", body: "Core flows are green. Realtime and session expiry still need a final pass.", hoursAfterCreation: 4 }],
        },
        {
          title: "Confirm monitoring and alert routes",
          description: "Check API error-rate, latency, queue depth, and database alerts reach the launch channel with useful context.",
          list: "In progress",
          createdBy: "amelia",
          assignees: ["amelia"],
          labels: ["Launch day"],
          dueOffsetDays: 0,
          dueDateSlot: "afternoon",
          fieldValues: { "Release version": "1.0.0", "Rollout percentage": 100, "Go / no-go approved": false },
        },
        {
          title: "Schedule launch announcement",
          description: "Load the approved announcement, verify links and social preview, then schedule it for the launch window.",
          list: "To do",
          createdBy: "amelia",
          assignees: ["amelia"],
          labels: ["Communications", "Launch day"],
          dueOffsetDays: 1,
          dueDateSlot: "morning",
          fieldValues: { "Release version": "1.0.0", "Go / no-go approved": true },
        },
        {
          title: "Review support handoff and canned replies",
          description: "Make sure ownership, escalation steps, and replies for access, billing, and data-import questions are ready.",
          list: "To do",
          createdBy: "amelia",
          assignees: ["amelia"],
          labels: ["Pre-launch", "Communications"],
          dueOffsetDays: 1,
          dueDateSlot: "afternoon",
          fieldValues: { "Release version": "1.0.0", "Go / no-go approved": false },
        },
        {
          title: "Capture launch-day baseline metrics",
          description: "Record current sign-ups, activation, API latency, and error rate so launch impact has a clean comparison point.",
          list: "To do",
          createdBy: "amelia",
          assignees: ["amelia"],
          labels: ["Post-launch"],
          dueOffsetDays: 2,
          dueDateSlot: "endOfWorkDay",
          fieldValues: { "Release version": "1.0.0", "Rollout percentage": 100 },
        },
        {
          title: "Verify backups and rollback runbook",
          description: "Confirm the latest backup can be identified and the rollback commands, owners, and decision threshold are documented.",
          list: "Done",
          createdBy: "amelia",
          assignees: ["amelia"],
          labels: ["Pre-launch", "Launch blocker"],
          fieldValues: { "Release version": "1.0.0", "Go / no-go approved": true },
          completedBy: "amelia",
          completedDaysAgo: 1,
          comments: [{ author: "amelia", body: "Restore test completed successfully; rollback owner and stop conditions are in the runbook.", hoursAfterCreation: 5 }],
        },
        {
          title: "Freeze release candidate",
          description: "Tag the approved build, lock the release commit, and share the artifact identifier in the launch notes.",
          list: "Done",
          createdBy: "amelia",
          assignees: ["amelia"],
          labels: ["Pre-launch"],
          fieldValues: { "Release version": "1.0.0", "Rollout percentage": 100, "Go / no-go approved": true },
          completedBy: "amelia",
          completedDaysAgo: 1,
        },
      ];

      // A standalone board still owns a workspace internally, so seed its content against the
      // hidden workspace's shared lists, fields, and labels just like a regular board.
      const standaloneCardCountsByList = new Map<string, number>();
      const standaloneCardIdentities = await allocateCardKeys(tx, standaloneWorkspace!.id, standaloneCards.length);
      for (const [cardIndex, cardSeed] of standaloneCards.entries()) {
        const listRow = standaloneListByName.get(cardSeed.list);
        if (!listRow) throw new Error(`Missing list '${cardSeed.list}' in standalone board.`);
        const listPosition = standaloneCardCountsByList.get(cardSeed.list) ?? 0;
        standaloneCardCountsByList.set(cardSeed.list, listPosition + 1);
        const completedAt = cardSeed.completedDaysAgo === undefined ? null : addHours(addDays(baseDate, -cardSeed.completedDaysAgo), 16);
        const cardCreatedAt = completedAt ? addDays(completedAt, -1) : addHours(standaloneCreatedAt, 5 + cardIndex);
        const [card] = await tx.insert(cards).values({
          ...standaloneCardIdentities[cardIndex]!,
          listId: listRow.id,
          boardId: standaloneBoard!.id,
          title: cardSeed.title,
          description: cardSeed.description,
          position: positionForIndex(listPosition),
          dueDateLocalDate: cardSeed.dueOffsetDays === undefined ? null : formatLocalDate(addDays(baseDate, cardSeed.dueOffsetDays)),
          dueDateSlot: cardSeed.dueDateSlot ?? null,
          dueDateTimezone: cardSeed.dueOffsetDays === undefined ? null : userTimezoneByKey.get("amelia")!,
          createdById: userIdByKey.get("amelia")!,
          completedAt,
          coverAttachmentId: null,
          createdAt: cardCreatedAt,
          updatedAt: completedAt ?? cardCreatedAt,
        }).returning();
        summary.cards += 1;

        await tx.insert(cardAssignees).values({ cardId: card!.id, userId: userIdByKey.get("amelia")!, assignedAt: addHours(cardCreatedAt, 1) });
        await tx.insert(cardLabelAssignments).values(cardSeed.labels.map((label, index) => {
          const labelRow = standaloneLabelByName.get(label);
          if (!labelRow) throw new Error(`Missing label '${label}' in standalone board.`);
          return { cardId: card!.id, labelId: labelRow.id, assignedAt: addHours(cardCreatedAt, index + 1) };
        }));
        if (cardSeed.fieldValues) {
          await tx.insert(cardCustomFieldValues).values(Object.entries(cardSeed.fieldValues).map(([fieldName, value]) => {
            const fieldRow = standaloneCustomFieldByName.get(fieldName);
            if (!fieldRow) throw new Error(`Missing field '${fieldName}' in standalone board.`);
            return { cardId: card!.id, fieldId: fieldRow.id, ...fieldValueUpdate(fieldName, fieldRow.type, value, new Map()), updatedAt: addHours(cardCreatedAt, 1) };
          }));
        }
        await recordActivity(tx, { boardId: standaloneBoard!.id, workspaceId: standaloneWorkspace!.id, actorId: userIdByKey.get("amelia")!, entityType: "card", entityId: card!.id, action: "created", payload: { title: cardSeed.title, listId: listRow.id } });
        if (completedAt) {
          await tx.insert(activityEvents).values({ boardId: standaloneBoard!.id, workspaceId: standaloneWorkspace!.id, actorId: userIdByKey.get("amelia")!, entityType: "card", entityId: card!.id, action: "completed", payload: { completedAt }, createdAt: completedAt });
        }

        for (const [checklistIndex, checklistSeed] of (cardSeed.checklists ?? []).entries()) {
          const seededItems = realisticChecklistItems(
            checklistSeed,
            `standalone:${cardIndex}:${checklistIndex}`,
            cardSeed.assignees.length,
          );
          const checklistCreatedAt = addHours(cardCreatedAt, checklistIndex + 1);
          const [checklist] = await tx.insert(cardChecklists).values({ cardId: card!.id, title: checklistSeed.title, position: positionForIndex(checklistIndex), createdAt: checklistCreatedAt, updatedAt: checklistCreatedAt }).returning();
          summary.checklists += 1;
          await tx.insert(cardChecklistItems).values(seededItems.map((item, itemIndex) => {
            const itemCompletedAt = item.completedBy ? addHours(cardCreatedAt, item.completedOffsetHours ?? itemIndex + 2) : null;
            return { checklistId: checklist!.id, text: item.text, position: positionForIndex(itemIndex), assigneeId: item.assignee ? userIdByKey.get(item.assignee)! : null, dueDateLocalDate: item.dueOffsetDays === undefined ? null : formatLocalDate(addDays(baseDate, item.dueOffsetDays)), dueDateSlot: item.dueDateSlot ?? null, dueDateTimezone: item.dueOffsetDays === undefined ? null : userTimezoneByKey.get("amelia")!, completedAt: itemCompletedAt, completedById: item.completedBy ? userIdByKey.get(item.completedBy)! : null, createdAt: checklistCreatedAt, updatedAt: itemCompletedAt ?? checklistCreatedAt };
          }));
          summary.checklistItems += checklistSeed.items.length;
        }
        for (const commentSeed of cardSeed.comments ?? []) {
          const [comment] = await tx.insert(comments).values({ cardId: card!.id, authorId: userIdByKey.get(commentSeed.author)!, body: commentSeed.body, createdAt: addHours(cardCreatedAt, commentSeed.hoursAfterCreation) }).returning();
          summary.comments += 1;
          await recordActivity(tx, { boardId: standaloneBoard!.id, workspaceId: standaloneWorkspace!.id, actorId: userIdByKey.get(commentSeed.author)!, entityType: "comment", entityId: comment!.id, action: "created", payload: { cardId: card!.id } });
        }
      }

      for (const [workspaceIndex, workspaceSeed] of workspaceSeeds.entries()) {
        const workspaceRoleByUser = new Map(workspaceSeed.members.map((member) => [member.user, member.role]));
        const workspaceCreatedAt = addDays(baseDate, -(32 - workspaceIndex * 4));
        const [workspace] = await tx
          .insert(workspaces)
          .values({
            clientId: client!.id,
            name: workspaceSeed.name,
            icon: workspaceSeed.icon,
            accentColor: workspaceSeed.accentColor,
            createdAt: workspaceCreatedAt,
            updatedAt: workspaceCreatedAt,
          })
          .returning();
        summary.workspaces += 1;

        await tx.insert(workspaceMembers).values(
          workspaceSeed.members.map((member) => ({
            workspaceId: workspace!.id,
            userId: userIdByKey.get(member.user)!,
            // Organisation owners/admins have admin authority in every same-org workspace, even
            // if a future demo roster accidentally assigns them a lower workspace-local role.
            role: isSeedOrgAdmin(member.user) ? "admin" : toWorkspaceRole(member.role),
            addedAt: addHours(workspaceCreatedAt, 1),
          })),
        );

        const listRows = await tx
          .insert(lists)
          .values(
            workspaceSeed.lists.map((listSeed, index) => ({
              workspaceId: workspace!.id,
              name: listSeed.name,
              icon: listSeed.icon ?? null,
              color: listSeed.color ?? null,
              position: positionForIndex(index),
              createdAt: addHours(workspaceCreatedAt, 2),
              updatedAt: addHours(workspaceCreatedAt, 2),
            })),
          )
          .returning();
        const listByName = new Map(listRows.map((row) => [row.name, row]));

        const customFieldRows = await tx
          .insert(customFields)
          .values(
            workspaceSeed.customFields.map((field, index) => ({
              workspaceId: workspace!.id,
              name: field.name,
              icon: field.icon ?? "forms",
              type: field.type,
              position: positionForIndex(index),
              showOnCard: field.showOnCard ?? true,
              createdAt: addHours(workspaceCreatedAt, 2),
              updatedAt: addHours(workspaceCreatedAt, 2),
            })),
          )
          .returning();
        const customFieldByName = new Map(customFieldRows.map((row) => [row.name, row]));
        const customFieldOptionRows = workspaceSeed.customFields.flatMap((field) => {
          if (!field.options?.length) return [];
          if (field.type !== "select") throw new Error(`Field '${field.name}' defines options but is not a select field.`);
          const fieldRow = customFieldByName.get(field.name);
          if (!fieldRow) throw new Error(`Missing custom field '${field.name}' in workspace '${workspaceSeed.name}'.`);
          return field.options.map((option, index) => ({
            fieldId: fieldRow.id,
            label: option.label,
            color: null,
            position: positionForIndex(index),
            createdAt: addHours(workspaceCreatedAt, 2),
            updatedAt: addHours(workspaceCreatedAt, 2),
          }));
        });
        const insertedCustomFieldOptionRows = customFieldOptionRows.length > 0
          ? await tx.insert(customFieldOptions).values(customFieldOptionRows).returning()
          : [];
        const customFieldNameById = new Map(customFieldRows.map((row) => [row.id, row.name]));
        const optionIdByFieldAndLabel = new Map<string, Map<string, string>>();
        for (const optionRow of insertedCustomFieldOptionRows) {
          const fieldName = customFieldNameById.get(optionRow.fieldId);
          if (!fieldName) continue;
          const optionByLabel = optionIdByFieldAndLabel.get(fieldName) ?? new Map<string, string>();
          optionByLabel.set(optionRow.label, optionRow.id);
          optionIdByFieldAndLabel.set(fieldName, optionByLabel);
        }

        const labelRows = await tx
          .insert(cardLabels)
          .values(
            workspaceSeed.labels.map((label, index) => ({
              workspaceId: workspace!.id,
              name: label.name,
              color: label.color,
              position: positionForIndex(index),
              createdAt: addHours(workspaceCreatedAt, 2),
              updatedAt: addHours(workspaceCreatedAt, 2),
            })),
          )
          .returning();
        const labelByName = new Map(labelRows.map((row) => [row.name, row]));

        const workspaceNotes = await insertSeedNotes({
          tx,
          storage,
          clientId: client!.id,
          uploadedKeys,
          assetCache,
          workspaceId: workspace!.id,
          boardId: null,
          parentNoteId: null,
          noteSeeds: workspaceSeed.notes ?? [],
          userIdByKey,
          baseCreatedAt: addHours(workspaceCreatedAt, 3),
        });
        summary.notes += workspaceNotes.notes;
        summary.attachments += workspaceNotes.attachments;

        for (const [boardIndex, boardSeed] of workspaceSeed.boards.entries()) {
          const boardCreatedAt = addDays(workspaceCreatedAt, boardIndex + 1);
          const [board] = await tx
            .insert(boards)
            .values({
              workspaceId: workspace!.id,
              name: boardSeed.name,
              description: boardSeed.description,
              icon: boardSeed.icon,
              iconColor: boardSeed.iconColor,
              position: positionForIndex(boardIndex),
              createdAt: boardCreatedAt,
              updatedAt: boardCreatedAt,
            })
            .returning();
          summary.boards += 1;

          if (boardSeed.key === "mobile-experience") {
            // Cross-organisation users receive board access directly and are deliberately not
            // added to the host workspace, preserving guest permission boundaries.
            await tx.insert(boardMembers).values({
              boardId: board!.id,
              userId: guestUser!.id,
              role: "editor",
              addedAt: addHours(boardCreatedAt, 1),
            });
          }
          const boardRoleByUser = new Map((boardSeed.members ?? []).map((member) => [member.user, member.role]));
          // Materialize board membership from the workspace roster: admins get pinned editor rows
          // (on every board, non-removable), members get their intended board role (defaulting to
          // editor, or a per-board override). Mirrors the runtime access model so a fresh seed is
          // immediately usable without relying on the migration backfill.
          await tx
            .insert(boardMembers)
            .values(
              workspaceSeed.members.map((member) => {
                // Org-wide admins cannot be observers on a board. Materialize their effective
                // authority as the same pinned editor row used for workspace admins.
                const isAdmin = isSeedOrgAdmin(member.user) || toWorkspaceRole(member.role) === "admin";
                return {
                  boardId: board!.id,
                  userId: userIdByKey.get(member.user)!,
                  role: isAdmin ? ("editor" as const) : toBoardRole(boardRoleByUser.get(member.user) ?? member.role),
                  pinned: isAdmin,
                  addedAt: addHours(boardCreatedAt, 1),
                };
              }),
            )
            .onConflictDoNothing();
          const assigneeScope = workspaceSeed.members;
          const assignableMemberKeys = new Set(
            assigneeScope
              // Keep seed data aligned with app/API behavior: observers can appear in
              // demos, comments, and uploads, but not as work owners.
              .filter((member) =>
                isSeedOrgAdmin(member.user) || (
                  member.role !== "observer" &&
                  workspaceRoleByUser.get(member.user) !== "observer" &&
                  boardRoleByUser.get(member.user) !== "observer"
                )
              )
              .map((member) => member.user),
          );

          await recordActivity(tx, {
            boardId: board!.id,
            workspaceId: workspace!.id,
            actorId: userIdByKey.get(boardSeed.createdBy)!,
            entityType: "board",
            entityId: board!.id,
            action: "created",
            payload: { name: boardSeed.name },
          });

          const boardNotes = await insertSeedNotes({
            tx,
            storage,
            clientId: client!.id,
            uploadedKeys,
            assetCache,
            workspaceId: workspace!.id,
            boardId: board!.id,
            parentNoteId: null,
            noteSeeds: boardSeed.notes ?? [],
            userIdByKey,
            baseCreatedAt: addHours(boardCreatedAt, 2),
          });
          summary.notes += boardNotes.notes;
          summary.attachments += boardNotes.attachments;

          const cardCountsByList = new Map<string, number>();
          const boardCardIdentities = await allocateCardKeys(tx, workspace!.id, boardSeed.cards.length);
          for (const [cardIndex, cardSeed] of boardSeed.cards.entries()) {
            const listRow = listByName.get(cardSeed.list);
            if (!listRow) throw new Error(`Missing list '${cardSeed.list}' in workspace '${workspaceSeed.name}'.`);

            const nextListCount = cardCountsByList.get(cardSeed.list) ?? 0;
            cardCountsByList.set(cardSeed.list, nextListCount + 1);

            // Historical completions need creation timestamps that precede them even when they
            // fall outside the workspace's normal active-card window.
            const completedDaysAgo = cardSeed.completedDaysAgo
              ?? (isCompletedList(cardSeed.list) ? Math.max(1, Math.abs(cardSeed.dueOffsetDays ?? 1)) : undefined);
            const completedBy = cardSeed.completedBy ?? (completedDaysAgo === undefined ? undefined : cardSeed.assignees[0] ?? cardSeed.createdBy);
            const completedAt = completedDaysAgo === undefined
              ? null
              : addHours(addDays(baseDate, -completedDaysAgo), 16);
            const cardCreatedAt = completedAt
              ? addDays(completedAt, -7)
              : cardSeed.createdDaysAgo === undefined
                ? addHours(addDays(boardCreatedAt, cardIndex), cardIndex % 5)
                : addHours(addDays(baseDate, -cardSeed.createdDaysAgo), boardIndex + 1);
            const [card] = await tx
              .insert(cards)
              .values({
                ...boardCardIdentities[cardIndex]!,
                listId: listRow.id,
                boardId: board!.id,
                title: cardSeed.title,
                description: cardSeed.description,
                position: positionForIndex(nextListCount),
                dueDateLocalDate:
                  cardSeed.dueOffsetDays === undefined ? null : formatLocalDate(addDays(baseDate, cardSeed.dueOffsetDays)),
                dueDateSlot: cardSeed.dueDateSlot ?? null,
                dueDateTimezone: cardSeed.dueOffsetDays === undefined ? null : (userTimezoneByKey.get(cardSeed.createdBy) ?? "UTC"),
                createdById: userIdByKey.get(cardSeed.createdBy)!,
                completedAt,
                coverAttachmentId: null,
                createdAt: cardCreatedAt,
                updatedAt: cardCreatedAt,
              })
              .returning();
            summary.cards += 1;

            // For "worked-in" workspaces (those declaring a list flow), reconstruct the card's list
            // history so the activity feed shows real progress instead of a single "created" entry.
            // The card was created in the origin list, then moved forward step by step to its current
            // list; every audit row is written at its true historical time so the feed orders correctly.
            const movementPath = workspaceSeed.listFlow
              ? seedMovementPath(cardSeed.list, workspaceSeed.listFlow, workspaceSeed.listSideEntries ?? {})
              : [cardSeed.list];
            const originListRow = listByName.get(movementPath[0]!) ?? listRow;

            if (workspaceSeed.listFlow) {
              await insertSeedActivity(tx, {
                boardId: board!.id,
                workspaceId: workspace!.id,
                actorId: userIdByKey.get(cardSeed.createdBy)!,
                entityType: "card",
                entityId: card!.id,
                action: "created",
                payload: { title: cardSeed.title, listId: originListRow.id },
                createdAt: cardCreatedAt,
              });

              if (movementPath.length > 1) {
                // Whoever owns the card is the natural mover; fall back to its creator for cards with
                // no assignee (idea cards never reach here because they have an empty movement path).
                const moverId = userIdByKey.get(cardSeed.assignees[0] ?? cardSeed.createdBy)!;
                // Moves sit between creation and the card "arriving" in its current list: shortly
                // before completion for done cards, or a short window after creation for active ones.
                // Spreading them evenly reads as steady progress rather than one instantaneous jump.
                const arrivalAt = completedAt
                  ? addHours(completedAt, -3)
                  : addHours(cardCreatedAt, 3 * (movementPath.length - 1) + 3);
                const spanMs = arrivalAt.getTime() - cardCreatedAt.getTime();
                const steps = movementPath.length - 1;
                for (let step = 0; step < steps; step++) {
                  const fromList = listByName.get(movementPath[step]!)!;
                  const toList = listByName.get(movementPath[step + 1]!)!;
                  const movedAt = addMinutes(
                    new Date(cardCreatedAt.getTime() + Math.round((spanMs * (step + 1)) / (steps + 1))),
                    0,
                  );
                  await insertSeedActivity(tx, {
                    boardId: board!.id,
                    workspaceId: workspace!.id,
                    actorId: moverId,
                    entityType: "card",
                    entityId: card!.id,
                    action: ACTIVITY_ACTION.MOVED,
                    // Names are stored alongside ids so the feed still renders if a demo later renames
                    // or deletes a list; the client prefers the live list name and falls back to these.
                    payload: {
                      fromListId: fromList.id,
                      toListId: toList.id,
                      fromListName: fromList.name,
                      toListName: toList.name,
                      prevPosition: card!.position,
                      position: card!.position,
                    },
                    createdAt: movedAt,
                  });
                  summary.cardMoves += 1;
                }
              }
            } else {
              await recordActivity(tx, {
                boardId: board!.id,
                workspaceId: workspace!.id,
                actorId: userIdByKey.get(cardSeed.createdBy)!,
                entityType: "card",
                entityId: card!.id,
                action: "created",
                payload: { title: cardSeed.title, listId: listRow.id },
              });
            }

            if (completedAt) {
              if (!completedBy) throw new Error(`Completed card '${cardSeed.title}' needs completedBy.`);
              // Seed the matching audit row at the historical time; recordActivity intentionally
              // uses the current time and therefore cannot represent old completion history.
              await tx.insert(activityEvents).values({
                boardId: board!.id,
                workspaceId: workspace!.id,
                actorId: userIdByKey.get(completedBy)!,
                entityType: "card",
                entityId: card!.id,
                action: "completed",
                payload: { completedAt },
                createdAt: completedAt,
              });
            }

            if (cardSeed.assignees.length > 0) {
              const invalidAssignees = cardSeed.assignees.filter((assignee) => !assignableMemberKeys.has(assignee));
              if (invalidAssignees.length > 0) {
                throw new Error(`Card '${cardSeed.title}' assigns non-assignable members: ${invalidAssignees.join(", ")}`);
              }
              await tx.insert(cardAssignees).values(
                cardSeed.assignees.map((assignee, assigneeIndex) => ({
                  cardId: card!.id,
                  userId: userIdByKey.get(assignee)!,
                  assignedAt: addHours(cardCreatedAt, assigneeIndex + 1),
                })),
              );
            }

            if (cardSeed.watchers?.length) {
              const invalidWatchers = cardSeed.watchers.filter((watcher) => !workspaceRoleByUser.has(watcher));
              if (invalidWatchers.length > 0) {
                throw new Error(`Card '${cardSeed.title}' has watchers outside the workspace: ${invalidWatchers.join(", ")}`);
              }
              await tx.insert(cardWatchers).values(cardSeed.watchers.map((watcher, watcherIndex) => ({
                cardId: card!.id,
                userId: userIdByKey.get(watcher)!,
                createdAt: addHours(cardCreatedAt, watcherIndex + 2),
              })));
            }

            if (!completedAt && cardSeed.dueOffsetDays !== undefined && cardSeed.dueOffsetDays < 0) {
              const overdueCreatedAt = addHours(addDays(baseDate, cardSeed.dueOffsetDays), 18);
              await tx.insert(activityEvents).values({
                boardId: board!.id,
                workspaceId: workspace!.id,
                actorId: null,
                actorKind: "system",
                entityType: "card",
                entityId: card!.id,
                action: "overdue",
                payload: {
                  dueDateLocalDate: card!.dueDateLocalDate,
                  dueDateSlot: card!.dueDateSlot,
                  dueDateTimezone: card!.dueDateTimezone,
                },
                createdAt: overdueCreatedAt,
                updatedAt: overdueCreatedAt,
              });
              const overdueRecipients = [...new Set([...(cardSeed.assignees ?? []), ...(cardSeed.watchers ?? [])])];
              if (overdueRecipients.length > 0) {
                await tx.insert(notifications).values(overdueRecipients.map((recipient) => ({
                  clientId: client!.id,
                  userId: userIdByKey.get(recipient)!,
                  activityId: null,
                  cardId: card!.id,
                  listId: listRow.id,
                  boardId: board!.id,
                  workspaceId: workspace!.id,
                  reason: "overdue" as const,
                  createdAt: overdueCreatedAt,
                }))).onConflictDoNothing();
                summary.notifications += overdueRecipients.length;
              }
            }

            if (cardSeed.labels.length > 0) {
              await tx.insert(cardLabelAssignments).values(
                cardSeed.labels.map((label, labelIndex) => {
                  const labelRow = labelByName.get(label);
                  if (!labelRow) throw new Error(`Missing label '${label}' in workspace '${workspaceSeed.name}'.`);
                  return {
                    cardId: card!.id,
                    labelId: labelRow.id,
                    assignedAt: addHours(cardCreatedAt, labelIndex + 1),
                  };
                }),
              );
            }

            if (cardSeed.fieldValues) {
              await tx.insert(cardCustomFieldValues).values(
                Object.entries(cardSeed.fieldValues).map(([fieldName, value]) => {
                  const fieldRow = customFieldByName.get(fieldName);
                  if (!fieldRow) throw new Error(`Missing field '${fieldName}' in workspace '${workspaceSeed.name}'.`);
                  return {
                    cardId: card!.id,
                    fieldId: fieldRow.id,
                    ...fieldValueUpdate(fieldName, fieldRow.type, value, optionIdByFieldAndLabel),
                    updatedAt: addHours(cardCreatedAt, 1),
                  };
                }),
              );
            }

            let latestCardTimestamp = completedAt ?? cardCreatedAt;

            for (const [checklistIndex, checklistSeed] of (cardSeed.checklists ?? []).entries()) {
              const seededItems = realisticChecklistItems(
                checklistSeed,
                `${workspaceSeed.key}:${boardSeed.key}:${cardIndex}:${checklistIndex}`,
                cardSeed.assignees.length,
              );
              const checklistCreatedAt = addHours(cardCreatedAt, checklistIndex + 1);
              const [checklist] = await tx
                .insert(cardChecklists)
                .values({
                  cardId: card!.id,
                  title: checklistSeed.title,
                  position: positionForIndex(checklistIndex),
                  createdAt: checklistCreatedAt,
                  updatedAt: checklistCreatedAt,
                })
                .returning();
              summary.checklists += 1;
              latestCardTimestamp = checklistCreatedAt > latestCardTimestamp ? checklistCreatedAt : latestCardTimestamp;

              const checklistActivity = {
                boardId: board!.id,
                workspaceId: workspace!.id,
                actorId: userIdByKey.get(cardSeed.createdBy)!,
                entityType: "card" as const,
                action: "checklist:created" as const,
                payload: { cardId: card!.id, checklistId: checklist!.id, title: checklistSeed.title },
              };
              // Keep this row in true chronological order for worked-in workspaces so it does not
              // jump above the card's earlier created/moved history in the feed.
              if (workspaceSeed.listFlow) {
                await insertSeedActivity(tx, { ...checklistActivity, entityId: card!.id, createdAt: checklistCreatedAt });
              } else {
                await recordActivity(tx, { ...checklistActivity, entityId: card!.id });
              }

              if (checklistSeed.items.length > 0) {
                const invalidItemAssignees = checklistSeed.items
                  .map((item) => item.assignee)
                  .filter((assignee): assignee is SeedUserKey => assignee !== undefined && !assignableMemberKeys.has(assignee));
                if (invalidItemAssignees.length > 0) {
                  throw new Error(`Checklist '${checklistSeed.title}' assigns non-assignable members: ${invalidItemAssignees.join(", ")}`);
                }

                const checklistItems = await tx.insert(cardChecklistItems).values(
                  seededItems.map((itemSeed, itemIndex) => {
                    const completedAt =
                      itemSeed.completedBy === undefined
                        ? null
                        : addHours(cardCreatedAt, itemSeed.completedOffsetHours ?? itemIndex + checklistIndex + 2);
                    const itemUpdatedAt = completedAt ?? checklistCreatedAt;
                    latestCardTimestamp = itemUpdatedAt > latestCardTimestamp ? itemUpdatedAt : latestCardTimestamp;

                    return {
                      checklistId: checklist!.id,
                      text: itemSeed.text,
                      position: positionForIndex(itemIndex),
                      assigneeId: itemSeed.assignee === undefined ? null : userIdByKey.get(itemSeed.assignee)!,
                      dueDateLocalDate:
                        itemSeed.dueOffsetDays === undefined ? null : formatLocalDate(addDays(baseDate, itemSeed.dueOffsetDays)),
                      dueDateSlot: itemSeed.dueDateSlot ?? null,
                      dueDateTimezone:
                        itemSeed.dueOffsetDays === undefined
                          ? null
                          : (userTimezoneByKey.get(itemSeed.assignee ?? cardSeed.createdBy) ?? "UTC"),
                      completedAt,
                      completedById: itemSeed.completedBy === undefined ? null : userIdByKey.get(itemSeed.completedBy)!,
                      createdAt: checklistCreatedAt,
                      updatedAt: itemUpdatedAt,
                    };
                  }),
                ).returning();
                summary.checklistItems += checklistSeed.items.length;

                // Checklist overdue notifications are standing attention items rather than feed
                // activity. Seed them directly so My Cards and the inbox both open populated.
                const overdueChecklistNotifications = checklistItems.flatMap((itemRow, itemIndex) => {
                  const itemSeed = seededItems[itemIndex]!;
                  if (itemSeed.completedBy || itemSeed.dueOffsetDays === undefined || itemSeed.dueOffsetDays >= 0 || !itemSeed.assignee) return [];
                  return [{
                    clientId: client!.id,
                    userId: userIdByKey.get(itemSeed.assignee)!,
                    activityId: null,
                    cardId: card!.id,
                    checklistItemId: itemRow.id,
                    listId: listRow.id,
                    boardId: board!.id,
                    workspaceId: workspace!.id,
                    reason: "checklist_item_overdue" as const,
                    createdAt: addHours(addDays(baseDate, itemSeed.dueOffsetDays), 18),
                  }];
                });
                if (overdueChecklistNotifications.length > 0) {
                  await tx.insert(notifications).values(overdueChecklistNotifications).onConflictDoNothing();
                  summary.notifications += overdueChecklistNotifications.length;
                }
              }
            }

            let coverAttachmentId: string | null = null;
            for (const [attachmentIndex, attachmentSeed] of (cardSeed.attachments ?? []).entries()) {
              if (!storage) throw new Error("Storage provider was not initialized.");
              const attachmentCreatedAt = addHours(cardCreatedAt, attachmentIndex + 2);
              const attachment = await createAttachmentRow({
                tx,
                storage,
                clientId: client!.id,
                uploadedKeys,
                assetCache,
                cardId: card!.id,
                uploadedById: userIdByKey.get(attachmentSeed.uploadedBy)!,
                asset: attachmentSeed.asset,
                createdAt: attachmentCreatedAt,
                shouldGenerateCover:
                  attachmentSeed.useAsCover === true || (attachmentSeed.useAsCover !== false && coverAttachmentId === null),
              });

              summary.attachments += 1;
              latestCardTimestamp = attachmentCreatedAt > latestCardTimestamp ? attachmentCreatedAt : latestCardTimestamp;
              if (!coverAttachmentId && attachment.coverImageUrl) coverAttachmentId = attachment.id;

              const attachmentActivity = {
                boardId: board!.id,
                workspaceId: workspace!.id,
                actorId: userIdByKey.get(attachmentSeed.uploadedBy)!,
                entityType: "card" as const,
                entityId: card!.id,
                action: "attachment_added" as const,
                payload: {
                  cardId: card!.id,
                  attachmentId: attachment.id,
                  fileName: attachment.fileName,
                  mimeType: attachment.mimeType,
                  source: attachment.source,
                },
              };
              // Historical timestamp for worked-in workspaces so the upload lands in feed order.
              if (workspaceSeed.listFlow) {
                await insertSeedActivity(tx, { ...attachmentActivity, createdAt: attachmentCreatedAt });
              } else {
                await recordActivity(tx, attachmentActivity);
              }
            }

            if (coverAttachmentId) {
              summary.cardCovers += 1;
              await tx
                .update(cards)
                .set({ coverAttachmentId, updatedAt: latestCardTimestamp })
                .where(eq(cards.id, card!.id));
            }

            for (const commentSeed of cardSeed.comments ?? []) {
              const commentCreatedAt = addHours(cardCreatedAt, commentSeed.hoursAfterCreation);
              const body = seedCommentBody(commentSeed, userIdByKey);
              const [comment] = await tx
                .insert(comments)
                .values({
                  cardId: card!.id,
                  authorId: userIdByKey.get(commentSeed.author)!,
                  body,
                  createdAt: commentCreatedAt,
                })
                .returning();
              summary.comments += 1;
              latestCardTimestamp = commentCreatedAt > latestCardTimestamp ? commentCreatedAt : latestCardTimestamp;

              if (commentSeed.mentions?.length) {
                const invalidMentions = commentSeed.mentions.filter((mentioned) => !workspaceRoleByUser.has(mentioned));
                if (invalidMentions.length > 0) {
                  throw new Error(`Comment on '${cardSeed.title}' mentions users outside the workspace: ${invalidMentions.join(", ")}`);
                }
                await tx.insert(cardMentions).values(commentSeed.mentions.map((mentioned) => ({
                  cardId: card!.id,
                  commentId: comment!.id,
                  userId: userIdByKey.get(mentioned)!,
                  source: "comment" as const,
                  createdAt: commentCreatedAt,
                }))).onConflictDoNothing();
                summary.mentions += commentSeed.mentions.length;
              }

              const [commentActivity] = await tx.insert(activityEvents).values({
                boardId: board!.id,
                workspaceId: workspace!.id,
                actorId: userIdByKey.get(commentSeed.author)!,
                entityType: "comment",
                entityId: comment!.id,
                action: "created",
                payload: { cardId: card!.id },
                createdAt: commentCreatedAt,
                updatedAt: commentCreatedAt,
              }).returning();

              // Mirror production fanout precedence: watchers first, assignees next, and explicit
              // mentions last. This produces a useful mixture of read history and live unread asks.
              const notificationReasonByUser = new Map<SeedUserKey, "watching" | "assigned" | "mentioned">();
              for (const watcher of cardSeed.watchers ?? []) notificationReasonByUser.set(watcher, "watching");
              for (const assignee of cardSeed.assignees) notificationReasonByUser.set(assignee, "assigned");
              for (const mentioned of commentSeed.mentions ?? []) notificationReasonByUser.set(mentioned, "mentioned");
              notificationReasonByUser.delete(commentSeed.author);
              if (notificationReasonByUser.size > 0) {
                await tx.insert(notifications).values([...notificationReasonByUser].map(([recipient, reason]) => ({
                  clientId: client!.id,
                  userId: userIdByKey.get(recipient)!,
                  activityId: commentActivity!.id,
                  cardId: card!.id,
                  listId: listRow.id,
                  boardId: board!.id,
                  workspaceId: workspace!.id,
                  reason,
                  readAt: commentSeed.unreadFor?.includes(recipient) ? null : addHours(commentCreatedAt, 6),
                  createdAt: commentCreatedAt,
                }))).onConflictDoNothing();
                summary.notifications += notificationReasonByUser.size;
              }
            }

            if (latestCardTimestamp > cardCreatedAt || coverAttachmentId) {
              await tx
                .update(cards)
                .set({ updatedAt: latestCardTimestamp, ...(coverAttachmentId ? { coverAttachmentId } : {}) })
                .where(eq(cards.id, card!.id));
            }
          }

          for (const [separatorIndex, separatorSeed] of (boardSeed.separators ?? []).entries()) {
            const listRow = listByName.get(separatorSeed.list);
            if (!listRow) throw new Error(`Missing list '${separatorSeed.list}' in workspace '${workspaceSeed.name}'.`);

            const separatorCreatedAt = addMinutes(boardCreatedAt, 30 + separatorIndex * 5);
            const [separator] = await tx
              .insert(boardSeparators)
              .values({
                boardId: board!.id,
                listId: listRow.id,
                title: separatorSeed.title,
                color: separatorSeed.color ?? null,
                position: separatorSeed.position,
                createdById: userIdByKey.get(separatorSeed.createdBy)!,
                createdAt: separatorCreatedAt,
                updatedAt: separatorCreatedAt,
              })
              .returning();
            summary.separators += 1;

            await recordActivity(tx, {
              boardId: board!.id,
              workspaceId: workspace!.id,
              actorId: userIdByKey.get(separatorSeed.createdBy)!,
              entityType: "separator",
              entityId: separator!.id,
              action: "created",
              payload: { title: separatorSeed.title, color: separatorSeed.color ?? null, listId: listRow.id },
            });
          }
        }

        summary.internalLinks += await seedInternalLinkDemos(tx, workspace!.id);
      }

      if (summary.cardCovers === 0) {
        throw new Error("Seed data created no card cover images.");
      }
    });

    if (!primaryClientId || !guestClientId) throw new Error("Seed data did not create both demo organisations.");
    return { summary, primaryClientId, guestClientId };
  } catch (error) {
    if (storage) {
      await Promise.allSettled(uploadedKeys.map((key) => storage!.delete(key)));
    }
    if (guestStorage) {
      await Promise.allSettled(guestUploadedKeys.map((key) => guestStorage!.delete(key)));
    }
    throw error;
  }
}
