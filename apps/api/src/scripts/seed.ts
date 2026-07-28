import type { ColorToken } from "@kanera/shared/colors";
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
import { db, pool, type Db } from "../db.js";
import { env } from "../env.js";
import { recordActivity } from "../lib/activity.js";
import { seedBoardMembersFromWorkspace } from "../lib/board-membership.js";
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

type SeedSummary = {
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
const SHARED_PASSWORD = "Abc12345";

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

const seedUserByKey = new Map([...USER_SEEDS, GUEST_USER_SEED].map((user) => [user.key, user]));

function note(...sections: string[]): string {
  return sections.join("\n\n");
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
              "Finalize the template model so onboarding can create opinionated boards, custom fields, and labels in one pass.",
              "Need a migration-safe API shape, seeded defaults for engineering teams, and QA coverage around workspace bootstrap.",
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
                  { text: "Confirm onboarding still triggers when the user has no workspace", assignee: "nina", dueOffsetDays: 3, dueDateSlot: "morning" },
                  { text: "Prepare rollback note for workspace bootstrap migration", assignee: "priya", dueOffsetDays: 4, dueDateSlot: "afternoon" },
                ],
              },
              {
                title: "API and migration",
                items: [
                  { text: "Verify the migration against a populated workspace", assignee: "omar", dueOffsetDays: 1, dueDateSlot: "morning" },
                  { text: "Confirm list and field positions retain their ordering", assignee: "ben", dueOffsetDays: 1, dueDateSlot: "afternoon" },
                  { text: "Exercise rollback and reapply locally", assignee: "omar", dueOffsetDays: 2, dueDateSlot: "morning" },
                  { text: "Review template validation error responses", assignee: "priya", dueOffsetDays: 2, dueDateSlot: "afternoon" },
                  { text: "Document the final payload example", assignee: "ben", dueOffsetDays: 3, dueDateSlot: "endOfWorkDay" },
                ],
              },
              {
                title: "Web onboarding",
                items: [
                  { text: "Test the empty-account onboarding route", assignee: "nina", dueOffsetDays: 1, dueDateSlot: "morning" },
                  { text: "Check template selection on a narrow viewport", assignee: "nina", dueOffsetDays: 1, dueDateSlot: "afternoon" },
                  { text: "Verify created boards appear without a reload", assignee: "ben", dueOffsetDays: 2, dueDateSlot: "morning" },
                  { text: "Confirm default custom fields render immediately", assignee: "priya", dueOffsetDays: 2, dueDateSlot: "afternoon" },
                  { text: "Check keyboard focus after workspace creation", assignee: "nina", dueOffsetDays: 3, dueDateSlot: "morning" },
                  { text: "Capture the completed onboarding flow", assignee: "ben", dueOffsetDays: 3, dueDateSlot: "endOfWorkDay" },
                ],
              },
              {
                title: "Release communications",
                items: [
                  { text: "Draft the internal rollout announcement", assignee: "priya", dueOffsetDays: 2, dueDateSlot: "morning" },
                  { text: "Prepare support troubleshooting notes", assignee: "nina", dueOffsetDays: 2, dueDateSlot: "afternoon" },
                  { text: "Add the workspace template example to release notes", assignee: "ben", dueOffsetDays: 3, dueDateSlot: "morning" },
                  { text: "Share the rollback owner and escalation path", assignee: "omar", dueOffsetDays: 3, dueDateSlot: "afternoon" },
                ],
              },
              {
                title: "Post-release verification",
                items: [
                  { text: "Create a workspace from a fresh owner account", assignee: "nina", dueOffsetDays: 5, dueDateSlot: "morning" },
                  { text: "Create a workspace from an invited member account", assignee: "nina", dueOffsetDays: 5, dueDateSlot: "afternoon" },
                  { text: "Confirm every board shares the seeded lists", assignee: "priya", dueOffsetDays: 6, dueDateSlot: "morning" },
                  { text: "Confirm every board shares the seeded custom fields", assignee: "ben", dueOffsetDays: 6, dueDateSlot: "afternoon" },
                  { text: "Review onboarding errors in activity history", assignee: "omar", dueOffsetDays: 7, dueDateSlot: "morning" },
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
              "Support reported duplicate export files whenever the storage write succeeds after the DB transaction is retried.",
              "Audit the retry boundary and make sure duplicate deliveries are visible in activity history.",
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
                  { text: "Reproduce duplicate delivery with storage success and DB retry", assignee: "nina", dueOffsetDays: -1, dueDateSlot: "morning", completedBy: "nina", completedOffsetHours: 9 },
                  { text: "Make export delivery insert idempotent", assignee: "omar", dueOffsetDays: 0, dueDateSlot: "afternoon" },
                  { text: "Verify activity history shows the retained delivery once", assignee: "priya", dueOffsetDays: 1, dueDateSlot: "morning" },
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
              "Investigate the first-load path for boards with heavy label and custom field usage.",
              "A smaller card summary payload may be enough if the detail panel keeps its current fetch model.",
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
              "Users need separate toggles for mentions, due dates, and watcher updates.",
              "This should share event names with the web notification center so we do not fork the contract.",
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
              "Confirm the happy path still lands on workspace creation when `me.hasWorkspace === false`.",
              "Regression risk is highest around the list and custom field defaults.",
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
                  { text: "Owner creates first workspace from empty account", assignee: "nina", dueOffsetDays: 1, dueDateSlot: "morning" },
                  { text: "Member sees onboarding instead of empty board shell", assignee: "nina", dueOffsetDays: 1, dueDateSlot: "afternoon" },
                  { text: "Default lists and custom fields match workspace seed", assignee: "priya", dueOffsetDays: 2, dueDateSlot: "morning" },
                  { text: "Mobile viewport lands on created workspace without reload", assignee: "ben", dueOffsetDays: 2, dueDateSlot: "endOfWorkDay" },
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
              "Use visible activity rows to prefill a weekly changelog draft for the product team.",
              "The first version can stay internal and export plain markdown.",
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
              "Local and S3 storage can drift when uploads fail after file write and before the row is inserted.",
              "Schedule a safe retry pass that only touches files not referenced by any card attachment row.",
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
              "The widget should pull from existing activity and due date data instead of introducing a separate analytics store.",
              "Need empty-state copy before the demo environment refresh.",
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
              "Finish the remaining keyboard traps in the attachment picker and mention menu.",
              "This is the last blocker before we can close the accessibility milestone.",
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
              "Document the current release branching approach, hotfix expectations, and deploy tagging rules.",
              "The guide should link back to the same terminology used in custom field reporting.",
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
              "The current skeleton does not reserve space for attachments or custom field chips, so the panel jumps on reconnect.",
              "Match the mobile layout to the current web detail hierarchy.",
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
                  { text: "Reserve attachment preview height before reconnect", assignee: "ben", dueOffsetDays: 2, dueDateSlot: "afternoon", completedBy: "ben", completedOffsetHours: 12 },
                  { text: "Add custom field chip placeholders", assignee: "ben", dueOffsetDays: 3, dueDateSlot: "morning" },
                  { text: "Retest PDF-first detail panels on iOS Safari", assignee: "nina", dueOffsetDays: 5, dueDateSlot: "morning" },
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
              "Customer reports show local notifications sometimes arrive without the card title after an app cold start.",
              "We need a reproducible path before the next beta drop.",
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
              "The sales team wants a cleaner workspace demo on iPad during partner meetings.",
              "Start with the board overview, member strip, and filters drawer.",
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
              "We can enable Face ID and fingerprint login later, but first we need to know how often users reach the re-auth wall.",
              "Telemetry should stay lightweight and privacy-safe.",
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
              "Check image previews, cover rendering, and PDF handoff on iOS Safari and Chrome for Android.",
              "This one blocks the marketing demo environment refresh.",
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
              "Prototype archive, complete, and reschedule actions without making drag-and-drop worse.",
              "If the gesture conflicts with scroll, we should stop after the prototype.",
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
              "Customer screenshots still show clipped label chips on small devices running custom fonts.",
              "We may need a platform-specific line-height tweak.",
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
              "Expose build number, API environment, and commit short SHA in settings for support troubleshooting.",
              "Reuse the generated build-info model from web where possible.",
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
              "The current message reads like a failure when uploads are just slow.",
              "Need a better status string for both image and document uploads.",
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
              "Write the internal playbook for notification token refresh, permissions reset, and stale badge counts.",
              "This supports the beta inbox while we finish the settings work.",
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
            { text: "Confirm final product messaging", assignee: "ben" as const },
            { text: "Approve campaign graphics", assignee: "amelia" as const, completedBy: "amelia" as const, completedOffsetHours: 8 },
            { text: "Verify landing-page tracking", assignee: "leo" as const, completedBy: "leo" as const, completedOffsetHours: 12 },
            { text: "Publish the launch-day schedule", assignee: "grace" as const },
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
            "Several interview customers said they already recommend Kanera informally. Explore whether a lightweight double-sided referral offer belongs in the autumn launch.",
            "Bring back one recommended mechanic, rough cost, fraud risks, and a clear reason to run it now—or park it.",
          ],
          createdBy: "amelia",
          comments: [{ author: "amelia", hoursAfterCreation: 5, body: "Please keep this deliberately small. I am more interested in qualified introductions than a high-volume discount code.", mentions: ["ben"] }],
        },
        {
          title: "Behind-the-scenes launch diary",
          assignee: "zoe",
          description: [
            "Turn the team's launch process into a short series showing how the campaign moves from customer research to launch day.",
            "The angle should feel useful rather than self-congratulatory; draft three possible episodes before we commit production time.",
          ],
          createdBy: "grace",
        },
        {
          title: "Add a pre-launch countdown teaser",
          assignee: "zoe",
          description: [
            "Test a short three-email teaser that builds anticipation in the week before launch without revealing the full announcement.",
            "Decide whether it reaches the whole customer base or only the campaign audience, and what the first email must promise to earn the next open.",
          ],
          createdBy: "grace",
        },
        {
          title: "Explore a launch-week partner content swap",
          assignee: "omar",
          description: [
            "Orbiflow offered a reciprocal mention in their launch-week newsletter in exchange for a slot in ours.",
            "Confirm the audience overlap is low enough to be worth it and agree the exact wording before either side commits.",
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
            "Consolidate the approved audience, promise, proof points, channel plan, and exclusions into the working brief.",
            "Product messaging is the only open section. Once that wording arrives, circulate version 1.0 and archive the workshop draft.",
          ],
          dueOffsetDays: 2,
          watchers: ["amelia", "zoe", "nina"],
          checklists: [{
            title: "Brief sign-off",
            items: [
              { text: "Insert final product promise", assignee: "ben" },
              { text: "Confirm audience exclusions", assignee: "amelia", completedBy: "amelia", completedOffsetHours: 6 },
              { text: "Link approved customer proof", assignee: "zoe", completedBy: "zoe", completedOffsetHours: 11 },
              { text: "Publish version 1.0 to the team", assignee: "grace" },
            ],
          }],
        },
        {
          title: "Build the launch measurement sheet",
          assignee: "leo",
          description: [
            "Create one measurement view for landing-page conversion, email engagement, partner referrals, and demo requests.",
            "Use last quarter as the baseline and call out which numbers are directional because attribution is incomplete.",
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
            "Produce the core visual system for the autumn launch: hero artwork, social crops, email header, and partner co-branding lockup.",
            "The current direction is the warm editorial route from concept two. Avoid product UI inside the hero artwork; Leo will supply screenshots separately.",
          ],
          dueOffsetDays: 3,
          attachments: [{ asset: "campaignReviewCover", uploadedBy: "nina", useAsCover: true }],
          checklists: [{
            title: "Required exports",
            items: [
              { text: "Landing-page hero at desktop and mobile sizes", assignee: "nina", completedBy: "nina", completedOffsetHours: 10 },
              { text: "Email header with dark-mode check", assignee: "nina" },
              { text: "Three social crops with safe areas", assignee: "nina" },
              { text: "Partner lockup without the launch date", assignee: "nina" },
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
            "Write the full landing-page narrative from the approved outline, including hero, problem framing, workflow proof, customer evidence, and final CTA.",
            "The draft currently uses a temporary product headline. Keep the supporting sections stable so the final wording can be swapped without another structural review.",
          ],
          dueOffsetDays: 2,
          createdBy: "ben",
          comments: [{ author: "ben", hoursAfterCreation: 12, body: "The customer proof section is strong. Please cut the second workflow example and use that space to answer the migration objection.", mentions: ["zoe"], unreadFor: ["zoe"] }],
        },
        {
          title: "Prepare the launch-week social schedule",
          assignee: "grace",
          description: [
            "Map the launch announcement, customer proof, product walkthrough, and partner posts across the first seven days.",
            "Leave two open slots for reactive posts and note who is responsible for replies on each channel.",
          ],
          createdBy: "ben",
          checklists: [{
            title: "Schedule coverage",
            items: [
              { text: "Draft launch-day posts", assignee: "grace", completedBy: "grace", completedOffsetHours: 7 },
              { text: "Add customer-story follow-up", assignee: "zoe" },
              { text: "Confirm partner posting windows", assignee: "omar" },
              { text: "Assign launch-day replies", assignee: "grace" },
            ],
          }],
        },
        {
          title: "Produce the launch-day explainer video",
          assignee: "nina",
          description: [
            "Cut a 60-second explainer that shows the shared-workspace idea through one continuous example rather than a feature tour.",
            "Keep the voiceover aligned with the approved landing-page copy so the launch reads as one message across every format.",
          ],
          dueOffsetDays: 4,
          createdBy: "ben",
          checklists: [{
            title: "Video production",
            items: [
              { text: "Storyboard from the approved script", assignee: "nina", completedBy: "nina", completedOffsetHours: 6 },
              { text: "Record screen capture on the launch build", assignee: "leo" },
              { text: "Add captions and dark-mode-safe titles", assignee: "nina" },
              { text: "Export square and landscape cuts", assignee: "nina" },
            ],
          }],
          comments: [{ author: "leo", hoursAfterCreation: 13, body: "The launch build will be stable on the preview URL from Thursday. Record after that so the footage matches the live landing page.", mentions: ["nina"] }],
        },
        {
          title: "Finalise the campaign tracking and UTM plan",
          assignee: "leo",
          description: [
            "Agree the UTM naming, source list, and event names so landing-page conversions, email clicks, and partner referrals reconcile in one report.",
            "Publish the shared convention before any channel goes live; fixing attribution after launch loses the first-day numbers we most want.",
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
            "Review the campaign as one customer experience rather than approving each asset in isolation.",
            "Check that the promise, proof, design, CTA, and partner language remain consistent across the landing page, email, and launch-day social posts.",
          ],
          createdBy: "ben",
          dueOffsetDays: 4,
          watchers: ["ben", "nina", "zoe"],
        },
        {
          title: "Approve the customer announcement email",
          assignee: "amelia",
          description: [
            "Review the near-final customer email for clarity, tone, and whether the opening earns the click without overstating the release.",
            "Zoe has supplied two subject lines. Choose one, leave any copy changes inline, and confirm the audience exclusions with Ben.",
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
          description: ["This description is replaced by the richer launch-readiness summary in the card builder."],
          createdBy: "amelia",
          dueOffsetDays: 5,
        },
        {
          title: "Confirm final product messaging",
          assignee: "ben",
          description: [
            "Product needs to confirm the short promise used in the hero, customer email, and partner toolkit.",
            "The open question is whether to lead with cross-board consistency or faster campaign coordination. Ben will update every dependent asset after the decision.",
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
            "The launch plan reserves a small paid placement in the partner newsletter, but the final rate card and cancellation terms have not arrived.",
            "Omar will chase the partner on Tuesday; no creative work should start until the placement size is confirmed.",
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
            "The team agreed to focus the launch on operations leaders at growing service businesses, with existing customers treated as a separate update audience.",
            "The decision record includes excluded segments, the research evidence, and the language each channel should use.",
          ],
          createdBy: "amelia",
          createdDaysAgo: 24,
        },
        {
          title: "Customer research synthesis shared",
          assignee: "zoe",
          description: [
            "Zoe condensed eight customer calls into the three problems and five phrases used throughout the campaign.",
            "The raw notes remain restricted; the shared synthesis contains approved, anonymised evidence that the whole team can quote.",
          ],
          createdBy: "ben",
          createdDaysAgo: 20,
          comments: [{ author: "amelia", hoursAfterCreation: 22, body: "This is exactly the level of detail the creative team needed. The phrase about rebuilding context every Monday should anchor the campaign.", mentions: ["zoe"] }],
        },
        {
          title: "Launch date locked across teams",
          assignee: "ben",
          description: [
            "Creative, content, web, events, and partner owners agreed a single launch date and the two-day change freeze around it.",
            "The date is recorded with the one person who can approve a change, so downstream schedules stopped quietly drifting.",
          ],
          createdBy: "amelia",
        },
        {
          title: "Competitive messaging scan completed",
          assignee: "zoe",
          description: [
            "Zoe reviewed how three adjacent tools describe shared structure and where our promise is genuinely different rather than simply louder.",
            "The findings sharpened the hero line and retired two claims that competitors already make more credibly.",
          ],
          createdBy: "ben",
        },
        {
          title: "Creative concept directions presented",
          assignee: "nina",
          description: [
            "Nina presented three visual directions for the launch; the warm editorial route was chosen and the other two archived with notes.",
            "The decision and its reasoning are recorded, so a later 'can we try the bold one' has an answer without reopening the choice.",
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
            "The current geometric illustrations feel colder than the product and customer photography used elsewhere.",
            "Collect references for a warmer editorial style that can still be produced quickly by the internal team; this is exploration, not a request for finished artwork.",
          ],
          createdBy: "amelia",
        },
        {
          title: "Create a small customer icon family",
          assignee: "nina",
          description: [
            "Customer stories need a consistent way to represent industries when photography is unavailable or restricted.",
            "Sketch six simple industry icons and test them at card-thumbnail size before proposing a broader set.",
          ],
          createdBy: "zoe",
        },
        {
          title: "Refresh the presentation icon set",
          assignee: "nina",
          description: [
            "The deck icons are a mix of three old styles collected over two years and no longer sit well beside the new illustrations.",
            "Draw a single small set covering the twenty concepts sales actually uses, and stop there rather than building an exhaustive library nobody maintains.",
          ],
          createdBy: "grace",
        },
        {
          title: "Define a light motion guideline",
          assignee: "nina",
          description: [
            "Set simple rules for the few places we animate—loading states, reveals, and the odd product GIF—so motion feels consistent instead of ad hoc.",
            "Keep it to durations, easing, and when not to animate; this is guidance for existing tools, not a request for a motion-design practice.",
          ],
          createdBy: "amelia",
        },
        {
          title: "Plan a shot list for the next office visit",
          assignee: "grace",
          description: [
            "The photographer is on site next month and we should not waste the slot on generic laptop-and-coffee stock.",
            "List the specific team, candid, and workspace shots the brand refresh and recruitment work actually need before the day is booked.",
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
            "Turn the approved colour roles into a single set of named tokens the website, email, and product can share.",
            "Agree the naming with Nina first so a colour is renamed in one place rather than re-picked slightly differently in each tool.",
          ],
          createdBy: "nina",
          labels: ["Design", "Web"],
        },
        {
          title: "Audit the remaining brand assets",
          assignee: "grace",
          description: [
            "Finish the inventory of sales decks, event files, social templates, documents, and partner kits still using the old visual system.",
            "Mark each item as retire, migrate, or leave alone, and identify an accountable owner for anything customer-facing.",
          ],
          createdBy: "nina",
          checklists: [{
            title: "Asset locations",
            items: [
              { text: "Sales and customer-success shared drives", assignee: "grace", completedBy: "grace", completedOffsetHours: 8 },
              { text: "Event and webinar folders", assignee: "omar" },
              { text: "Website download library", assignee: "leo" },
              { text: "Partner enablement kit", assignee: "grace" },
            ],
          }],
        },
        {
          title: "Collect departmental brand requests",
          assignee: "grace",
          description: [
            "Sales, customer success, and recruitment each have recurring materials that the refresh needs to support.",
            "Ask for real examples and frequency of use—not wish lists—then group the requests into reusable templates.",
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
            "Rebuild the core sales deck with the approved type scale, colour tokens, image treatment, and flexible proof-point layouts.",
            "The template must work for a ten-slide first call and a longer procurement deck without encouraging tiny text.",
          ],
          createdBy: "grace",
          dueOffsetDays: 7,
          comments: [{ author: "grace", hoursAfterCreation: 14, body: "Sales uses the comparison slide in almost every call. Please keep a version with three columns even if it is not the prettiest layout.", mentions: ["nina"] }],
        },
        {
          title: "Build the social template kit",
          assignee: "nina",
          description: [
            "Create reusable layouts for announcements, customer quotations, event promotion, product tips, and simple data points.",
            "Each layout needs square and portrait variants, safe-area guidance, and an example with deliberately awkward copy.",
          ],
          createdBy: "grace",
          checklists: [{
            title: "Template set",
            items: [
              { text: "Announcement and release", assignee: "nina", completedBy: "nina", completedOffsetHours: 6 },
              { text: "Customer quotation", assignee: "nina", completedBy: "nina", completedOffsetHours: 15 },
              { text: "Event promotion", assignee: "nina" },
              { text: "Product tip and data point", assignee: "nina" },
              { text: "Usage notes for non-designers", assignee: "grace" },
            ],
          }],
          comments: [{ author: "zoe", hoursAfterCreation: 18, body: "I added a deliberately long customer quote to the working file. It breaks the current portrait layout at about 190 characters.", mentions: ["nina"] }],
        },
        {
          title: "Rewrite the brand voice examples",
          assignee: "zoe",
          description: [
            "Replace abstract tone words with before-and-after examples drawn from real emails, web pages, product announcements, and support-adjacent content.",
            "Show where the voice becomes more direct for incidents or billing; the brand should not sound equally cheerful in every situation.",
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
            "Review the proposed colour roles, accessible pairings, and examples of when the accent palette becomes too dominant.",
            "Leo has already checked the web combinations. This review is about brand intent and usability by non-designers.",
          ],
          createdBy: "nina",
          comments: [{ author: "leo", hoursAfterCreation: 9, body: "All documented text/background pairs pass AA. I flagged two chart combinations that become indistinguishable in common colour-vision simulations.", mentions: ["nina", "amelia"] }],
        },
        {
          title: "Approve the revised voice guidance",
          assignee: "amelia",
          description: [
            "Approve the principles and worked examples that will replace the old 'clear, human, bold' one-pager.",
            "Legal still needs to comment on the claims examples, but the everyday product and campaign language is ready for a decision.",
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
            "Legal is reviewing six examples that show how to make outcome claims without implying guaranteed results.",
            "Zoe has supplied the source evidence and proposed safer alternatives; the rest of the voice guide can proceed independently.",
          ],
          createdBy: "amelia",
          comments: [{ author: "zoe", hoursAfterCreation: 20, body: "Four examples are cleared. The two remaining questions both use the phrase 'eliminates admin', so I have drafted a less absolute fallback.", mentions: ["amelia"] }],
        },
        {
          title: "Receive the final photography licence",
          assignee: "nina",
          description: [
            "The preferred photographer has approved the crop and colour treatment but has not countersigned the expanded web and event usage.",
            "Do not publish the new homepage portraits until the signed licence is attached here.",
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
            "The guide now covers minimum size, clear space, partner lockups, single-colour use, and the handful of backgrounds that require the white mark.",
            "Old logo exports were moved into an archive folder and the partner kit now links to the controlled source files.",
          ],
          createdBy: "amelia",
          createdDaysAgo: 27,
        },
        {
          title: "Legacy templates archived",
          assignee: "grace",
          description: [
            "Grace removed the obsolete deck, document, and social templates from shared favourites and replaced them with an archive notice.",
            "Teams can still recover prior campaign files, but new work now starts from the refreshed system.",
          ],
          createdBy: "nina",
          createdDaysAgo: 16,
        },
        {
          title: "Brand type scale finalised",
          assignee: "nina",
          description: [
            "The refreshed type scale, weights, and line-height rules are documented with worked examples for headings, body, and dense UI text.",
            "The scale was tested against the longest real customer name and the smallest card label so it survives contact with actual content.",
          ],
          createdBy: "amelia",
        },
        {
          title: "Primary typeface licence renewed",
          assignee: "grace",
          description: [
            "The web and desktop licences for the brand typeface were renewed and the seat count reconciled against who actually designs.",
            "The renewal terms and the coverage for embedding the font in exported PDFs are recorded so the next renewal is not a scramble.",
          ],
          createdBy: "amelia",
        },
        {
          title: "Brand principles one-pager published",
          assignee: "zoe",
          description: [
            "The old 'clear, human, bold' poster was replaced with a one-pager that states each principle and shows one thing it rules out.",
            "It links to the fuller voice and colour guidance rather than repeating it, so the summary stays short enough to actually be read.",
          ],
          createdBy: "nina",
        },
        {
          title: "Refresh kickoff workshop held",
          assignee: "nina",
          description: [
            "The team ran the kickoff that agreed the refresh scope, the non-negotiables, and what was explicitly out of scope for this round.",
            "The decisions are written up so new requests can be measured against the agreed scope instead of quietly expanding it.",
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
            "Search and sales calls suggest that operations leaders struggle to see themselves in the current generic use-case pages.",
            "Before building anything, test whether one focused page can reuse existing proof and earn enough qualified traffic to justify maintenance.",
          ],
          createdBy: "ben",
        },
        {
          title: "Add a browsable partner directory",
          assignee: "omar",
          description: [
            "Partners want a public place to verify integrations and service relationships without requesting a PDF from sales.",
            "Define the minimum useful listing, ownership rules, and how inactive partners would be removed before asking Leo for an estimate.",
          ],
          createdBy: "grace",
          comments: [{ author: "leo", hoursAfterCreation: 16, body: "Please include who owns the source data. The build is straightforward; stale partner status is the part that could make this expensive.", mentions: ["omar"] }],
        },
        {
          title: "Add a status page link to the site footer",
          assignee: "leo",
          description: [
            "Prospects in security reviews keep asking where the public status page is, and it is currently buried two clicks into the docs.",
            "Add a footer link and confirm with DevOps that the status page is the right one to expose before we point traffic at it.",
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
            "Sales says the same three billing and rollout questions arrive after every pricing-page visit, which means the page is not answering them.",
            "Rewrite the FAQ from real questions reps field, and cut the two entries that only exist to sound reassuring.",
          ],
          createdBy: "ben",
        },
        {
          title: "Compress and lazy-load marketing-site imagery",
          assignee: "leo",
          description: [
            "Several marketing pages ship full-resolution artwork that hurts mobile load time and the largest-contentful-paint score.",
            "Compress the worst offenders and lazy-load below-the-fold images without regressing the hero, which must still paint immediately.",
          ],
          createdBy: "leo",
          labels: ["Web", "Analytics"],
        },
        {
          title: "Define the homepage update scope",
          assignee: "ben",
          description: [
            "Turn the homepage review into a bounded update covering the hero, proof order, primary CTA, and the first product section.",
            "Do not pull navigation or pricing into this round. Record those findings separately so the autumn launch is not delayed by a site-wide redesign.",
          ],
          createdBy: "amelia",
          checklists: [{
            title: "Scope decisions",
            items: [
              { text: "Agree the primary homepage audience", assignee: "ben", completedBy: "ben", completedOffsetHours: 4 },
              { text: "Choose the lead customer proof", assignee: "zoe" },
              { text: "Confirm sections explicitly out of scope", assignee: "amelia", completedBy: "amelia", completedOffsetHours: 9 },
              { text: "Write the measurement hypothesis", assignee: "leo" },
            ],
          }],
        },
        {
          title: "Gather approved homepage testimonials",
          assignee: "grace",
          description: [
            "Build a shortlist of concise customer quotations that support the new homepage promise and already have a traceable source.",
            "Prioritise customers with approved logo usage. Anything requiring fresh legal approval should be marked as a fallback, not part of the launch path.",
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
            "Implement the campaign page from Zoe's approved structure using the existing marketing-site components.",
            "The page needs responsive artwork, campaign-source persistence, accessible form errors, and a clean fallback when the customer quotation is removed.",
          ],
          dueOffsetDays: 3,
          createdBy: "ben",
          checklists: [{
            title: "Build and QA",
            items: [
              { text: "Implement responsive page sections", assignee: "leo", completedBy: "leo", completedOffsetHours: 8 },
              { text: "Wire campaign-source tracking", assignee: "leo", completedBy: "leo", completedOffsetHours: 14 },
              { text: "Add no-quotation fallback", assignee: "leo" },
              { text: "Test form errors with keyboard only", assignee: "leo" },
              { text: "Run final mobile visual check", assignee: "nina" },
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
            "Develop a headline and supporting line that explain the shared-workspace advantage without assuming visitors already understand Kanera's board model.",
            "Bring three materially different routes to review, each paired with the customer evidence that makes the promise credible.",
          ],
          createdBy: "ben",
          comments: [{ author: "amelia", hoursAfterCreation: 11, body: "Route one is closest, but 'one operating system' sounds larger than the evidence supports. Keep the idea of shared structure and make the claim more literal.", mentions: ["zoe"] }],
        },
        {
          title: "Update the customer-story page layout",
          assignee: "leo",
          description: [
            "Improve long-form story pages so results, customer context, and key quotations are scannable without turning every story into the same rigid template.",
            "Use the Northshore draft as the stress test and preserve sensible reading order when optional metrics or photography are missing.",
          ],
          createdBy: "zoe",
        },
        {
          title: "Rebuild the mobile navigation",
          assignee: "leo",
          description: [
            "The current mobile menu hides the demo-request CTA behind two taps, which the analytics dashboard shows is where mobile visitors drop.",
            "Rebuild it so the primary CTA is always reachable and the menu is fully operable with a screen reader, not only by touch.",
          ],
          dueOffsetDays: 6,
          createdBy: "ben",
          checklists: [{
            title: "Navigation rebuild",
            items: [
              { text: "Prototype the collapsed menu with the CTA pinned", assignee: "leo", completedBy: "leo", completedOffsetHours: 9 },
              { text: "Wire keyboard focus trapping and escape", assignee: "leo" },
              { text: "Screen-reader pass on open and close", assignee: "leo" },
              { text: "Check tap targets against the mobile guidelines", assignee: "nina" },
            ],
          }],
        },
        {
          title: "Write the operations industry page copy",
          assignee: "zoe",
          description: [
            "Draft the copy for the operations industry page so it reuses existing proof instead of inventing new claims that need fresh approval.",
            "Lead with the problem operations leads describe in sales calls; the product framing comes after they recognise their own situation.",
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
            "Review the complete preview against the campaign brief, concentrating on message order, CTA clarity, proof, and the handoff into the demo-request form.",
            "Log copy nits inline, but keep this card for decisions that affect launch readiness or another channel.",
          ],
          createdBy: "leo",
          dueOffsetDays: 4,
          watchers: ["zoe", "nina"],
        },
        {
          title: "Complete the landing-page accessibility pass",
          assignee: "leo",
          description: [
            "Run the pre-launch accessibility pass after the final content is in place.",
            "Cover headings, keyboard order, focus visibility, form errors, contrast, reduced motion, and the meaning of linked CTA text—not only automated checks.",
          ],
          createdBy: "ben",
          labels: ["Web"],
          checklists: [{
            title: "Accessibility review",
            items: [
              { text: "Automated scan with final content", assignee: "leo", completedBy: "leo", completedOffsetHours: 5 },
              { text: "Keyboard and visible-focus pass", assignee: "leo" },
              { text: "Screen-reader form-error check", assignee: "leo" },
              { text: "Reduced-motion and zoom check", assignee: "leo" },
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
            "Northshore has approved the underlying interview but still needs to confirm the shortened quotation and homepage placement.",
            "The page can launch with the Orbiflow fallback. Grace will swap in Northshore only if written approval arrives before final QA.",
          ],
          createdBy: "zoe",
          dueOffsetDays: 2,
          comments: [{ author: "grace", hoursAfterCreation: 18, body: "Their customer lead is comfortable with the edit and has sent it to legal. I have moved the fallback quote into the build so we are not blocked.", mentions: ["leo", "zoe"] }],
        },
        {
          title: "Legal review of the privacy-page update",
          assignee: "leo",
          description: [
            "The form now explains campaign-source tracking and links to a short privacy-page clarification.",
            "Legal is reviewing that paragraph only; it does not change retention or the underlying policy. Leo will publish the approved wording with the landing page.",
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
            "Every public page now has an owner, last-reviewed date, audience, and action: keep, revise, merge, or retire.",
            "The audit exposed nine unowned pages and three conflicting product descriptions; follow-up work has been split into separate cards.",
          ],
          createdBy: "ben",
          createdDaysAgo: 30,
        },
        {
          title: "Marketing analytics dashboard configured",
          assignee: "leo",
          description: [
            "The dashboard now separates anonymous traffic, campaign sessions, form starts, qualified demo requests, and customer-only visits.",
            "Bot filters and internal traffic exclusions are documented, and the team has a weekly annotation habit for launches and outages.",
          ],
          createdBy: "amelia",
          createdDaysAgo: 22,
          comments: [{ author: "ben", hoursAfterCreation: 23, body: "The form-start to qualified-request view already answered a question we have argued about for months. I added the dashboard to the Monday review note.", mentions: ["leo"] }],
        },
        {
          title: "Broken-link sweep completed",
          assignee: "leo",
          description: [
            "The full-site crawl found and fixed thirty-one broken links, most pointing at retired blog posts and moved help-centre pages.",
            "The remaining external dead links now redirect to the nearest live page, and the crawl is scheduled to run monthly rather than on request.",
          ],
          createdBy: "grace",
        },
        {
          title: "Cookie-consent banner updated",
          assignee: "leo",
          description: [
            "The consent banner now matches the current analytics and marketing tags, and non-essential scripts genuinely wait for opt-in.",
            "Legal signed off on the wording, and the choice is remembered across the marketing site and the app login page.",
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
            "Consider a research-led article about how small operations teams are standardising work across clients without buying a heavyweight enterprise platform.",
            "Before commissioning research, outline the claim we could credibly own, the data we already have, and what would make the piece useful after launch month.",
          ],
          createdBy: "amelia",
          attachments: [{ asset: "contentOperationsTrendsResearch", uploadedBy: "zoe", useAsCover: true }],
        },
        {
          title: "Customer interview mini-series",
          assignee: "ben",
          description: [
            "Explore a recurring interview format focused on one operating habit customers changed, rather than a full company profile every time.",
            "Propose the format, candidate list, consent approach, and realistic publishing cadence. Avoid promising a monthly series until two interviews are recorded.",
          ],
          createdBy: "zoe",
          attachments: [{ asset: "contentCustomerInterviewRecording", uploadedBy: "ben", useAsCover: true }],
        },
        {
          title: "Repurpose the Northshore story into a short video",
          assignee: "zoe",
          description: [
            "Once the Northshore story is approved, cut a two-minute video version for social and the customer newsletter using the same verified numbers.",
            "This is contingent on written video consent, which is separate from the text approval; do not storyboard anything that needs footage we cannot use.",
          ],
          createdBy: "grace",
        },
        {
          title: "Trial a monthly 'how we work' note",
          assignee: "ben",
          description: [
            "Test a short monthly note that shares one thing the team changed about how it works, written for customers rather than as a company update.",
            "Draft the first two before committing to a cadence; the format only earns a subscription if it stays specific and does not become a newsletter of wins.",
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
            "Sketch the structure of the benchmark report so it is ready to fill the moment the research partner delivers the weighted data.",
            "Outline the narrative and the charts we want, but leave every number as a placeholder until the methodology note is attached.",
          ],
          createdBy: "ben",
        },
        {
          title: "Prepare the Northshore customer interview",
          assignee: "ben",
          description: [
            "Prepare a 45-minute interview with Northshore's operations lead about replacing separate departmental trackers with one shared workflow.",
            "Use the approved questions as a base, add follow-ups around adoption and measurable change, and send the recording consent before the call.",
          ],
          dueOffsetDays: 5,
          createdBy: "zoe",
          attachments: [{ asset: "contentInterviewPreparation", uploadedBy: "ben", useAsCover: true }],
          checklists: [{
            title: "Interview preparation",
            items: [
              { text: "Review account timeline with customer success", assignee: "ben", completedBy: "ben", completedOffsetHours: 7 },
              { text: "Tailor approved question set", assignee: "ben" },
              { text: "Send recording and quotation consent", assignee: "grace" },
              { text: "Prepare a no-metrics fallback angle", assignee: "zoe" },
            ],
          }],
        },
        {
          title: "Draft next quarter's content calendar",
          assignee: "zoe",
          description: [
            "Turn the campaign, customer-story, product, and event commitments into a realistic twelve-week editorial plan.",
            "Reserve capacity for reactive work and show the intended audience and distribution path for every substantial piece—not just a publishing date.",
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
            "Draft the Northshore story around the shift from five team-specific trackers to one shared operating rhythm.",
            "Use only verified numbers, keep the implementation section honest about migration effort, and leave clear placeholders for quotations awaiting customer approval.",
          ],
          createdBy: "ben",
          attachments: [
            { asset: "contentCustomerStoryDraft", uploadedBy: "zoe", useAsCover: true },
            { asset: "screenshotRedlineReview", uploadedBy: "zoe" },
          ],
          checklists: [{
            title: "Story draft",
            items: [
              { text: "Verify company and team context", assignee: "grace", completedBy: "grace", completedOffsetHours: 6 },
              { text: "Draft problem and decision sections", assignee: "zoe", completedBy: "zoe", completedOffsetHours: 12 },
              { text: "Validate migration details with customer success", assignee: "ben" },
              { text: "Add only sourced outcome numbers", assignee: "zoe" },
              { text: "Prepare customer approval copy", assignee: "grace" },
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
            "Assemble this month's customer newsletter around the autumn preview, the new workspace guide, and two small product improvements.",
            "Keep it useful for customers who are not part of the campaign audience. One primary CTA is enough; the remaining items should link quietly from short summaries.",
          ],
          dueOffsetDays: 6,
          createdBy: "zoe",
          attachments: [{ asset: "contentNewsletterAssembly", uploadedBy: "grace", useAsCover: true }],
          checklists: [{
            title: "Newsletter assembly",
            items: [
              { text: "Collect product update summaries", assignee: "grace", completedBy: "grace", completedOffsetHours: 9 },
              { text: "Write autumn preview", assignee: "zoe" },
              { text: "Confirm help-centre destination", assignee: "leo" },
              { text: "Build and test the email", assignee: "grace" },
              { text: "Check suppression lists", assignee: "ben" },
            ],
          }],
        },
        {
          title: "Edit the campaign announcement article",
          assignee: "zoe",
          description: [
            "Edit the founder's announcement draft into a concise explanation of what changed, why shared structure matters, and where customers can learn more.",
            "Remove the internal launch history, preserve Amelia's personal opening, and align the product terminology with the final campaign brief.",
          ],
          createdBy: "amelia",
          attachments: [{ asset: "contentAnnouncementEdit", uploadedBy: "zoe", useAsCover: true }],
          comments: [{ author: "amelia", hoursAfterCreation: 8, body: "Please keep the opening anecdote, but I agree the middle reads like an internal retrospective. Cut anything a customer needs our org chart to understand.", mentions: ["zoe"] }],
        },
        {
          title: "Draft the autumn product-update changelog post",
          assignee: "grace",
          description: [
            "Write the customer-facing changelog post covering the shared-workspace improvements shipping alongside the campaign, grouped by what the change lets people do.",
            "Keep each entry to the outcome and one line of detail; the full release notes live in the help centre and this post should link to them, not replace them.",
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
            "Review the first complete Northshore draft for narrative clarity, evidence, customer sensitivity, and whether the headline matches the actual outcome.",
            "Separate required corrections from optional polish so Zoe can prepare a clean customer-review version without a week of internal wordsmithing.",
          ],
          createdBy: "zoe",
          dueOffsetDays: 3,
          attachments: [{ asset: "contentEditorialReview", uploadedBy: "ben", useAsCover: true }],
        },
        {
          title: "Approve the newsletter send",
          assignee: "amelia",
          description: [
            "Review the rendered newsletter, subject line, audience, and destination links before Grace schedules it.",
            "Product facts have already been checked. Focus this pass on customer value, tone, and whether the autumn preview is appropriately restrained.",
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
            "Northshore is reviewing the final narrative, two direct quotations, the team-size description, and the proposed screenshots.",
            "The approval is three days late. Ben will offer publication without screenshots if image review is the only remaining concern.",
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
            "The research partner owes the final anonymised cut of the operations-work survey plus the methodology note.",
            "Zoe can outline the report now, but no percentages should enter copy or design until the weighted data and sample exclusions are documented.",
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
            "Customer success and Northshore approved the interview structure, sensitive topics, and recording language.",
            "The final set prioritises operating change and adoption; speculative ROI questions were removed because the source data is not comparable.",
          ],
          createdBy: "zoe",
          createdDaysAgo: 19,
        },
        {
          title: "Previous quarter's content calendar shared",
          assignee: "zoe",
          description: [
            "The prior quarter's calendar was published with owners, audiences, distribution plans, and protected capacity for product changes.",
            "The team completed eleven of fourteen planned pieces; the retrospective notes explain why two low-value articles were deliberately dropped.",
          ],
          createdBy: "ben",
          createdDaysAgo: 32,
          comments: [{ author: "amelia", hoursAfterCreation: 20, body: "The visible dropped work is helpful. Please carry that convention into next quarter instead of quietly moving everything we choose not to publish.", mentions: ["zoe"] }],
        },
        {
          title: "Customer quote library organised",
          assignee: "grace",
          description: [
            "Every approved customer quotation now lives in one place with its source, approval status, logo rights, and the context it can be used in.",
            "Writers can now reach for a quote without emailing customer success, and expired approvals are flagged rather than quietly reused.",
          ],
          createdBy: "zoe",
        },
        {
          title: "SEO refresh of the top ten articles",
          assignee: "zoe",
          description: [
            "The ten highest-traffic articles were updated for accuracy, internal links, and current product terminology without chasing keyword density.",
            "Two articles that ranked for the wrong intent were repointed at a more suitable page rather than rewritten to fit a query we do not want.",
          ],
          createdBy: "leo",
          createdDaysAgo: 38,
        },
        {
          title: "Editorial style guide updated",
          assignee: "zoe",
          description: [
            "The style guide now matches the refreshed brand voice, with product-term spellings, capitalisation, and the customer-quotation rules in one place.",
            "It is short and example-led on purpose; the previous version was thorough enough that nobody opened it.",
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
            "Explore an off-the-record virtual roundtable for eight to ten operations leads who are standardising work across multiple teams.",
            "The value should be peer exchange, not a disguised product demo. Propose the discussion prompt, invite profile, and what participants receive afterwards.",
          ],
          createdBy: "amelia",
        },
        {
          title: "Regional operations conference sponsorship",
          assignee: "omar",
          description: [
            "Assess the regional operations conference as a possible spring sponsorship after two customers independently mentioned attending.",
            "Compare the attendee profile, speaking access, lead terms, total delivery cost, and what we would stop doing to fund it.",
          ],
          createdBy: "ben",
        },
        {
          title: "Host customer-only office hours",
          assignee: "omar",
          description: [
            "Trial a recurring low-production video session where customers bring real coordination problems and the team works through them live.",
            "Keep it firmly off the sales path; the value is candid help, and any product answers should be the honest ones, including 'we don't do that yet'.",
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
            "Write a one-page brief for the autumn webinar with Orbiflow covering the audience, promise, speaker roles, demo boundaries, and follow-up path.",
            "The session should teach a repeatable workflow first and show the integration second. Avoid a split presentation with two unrelated sales pitches.",
          ],
          createdBy: "ben",
          checklists: [{
            title: "Brief inputs",
            items: [
              { text: "Confirm the audience with partner marketing", assignee: "omar", completedBy: "omar", completedOffsetHours: 5 },
              { text: "Agree the single learning outcome", assignee: "ben" },
              { text: "Define demo ownership and boundaries", assignee: "omar" },
              { text: "Document lead-sharing consent", assignee: "grace" },
            ],
          }],
        },
        {
          title: "Shortlist next quarter's event opportunities",
          assignee: "omar",
          description: [
            "Reduce the inbound conference and webinar opportunities to a shortlist the team can actually support next quarter.",
            "Score audience fit, speaking quality, partner value, preparation cost, and follow-up capacity. A strong recommendation to decline is a valid outcome.",
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
            "Coordinate the autumn customer webinar from confirmed date through rehearsal, broadcast, recording handoff, and attendee follow-up.",
            "The working date is fixed. The two current risks are the guest speaker's availability and whether the partner demo account can be shared during rehearsal.",
          ],
          dueOffsetDays: 1,
          dueDateSlot: "endOfWorkDay",
          createdBy: "ben",
          watchers: ["amelia", "grace", "leo"],
          checklists: [{
            title: "Webinar production",
            items: [
              { text: "Confirm run of show", assignee: "omar", completedBy: "omar", completedOffsetHours: 7 },
              { text: "Book speaker rehearsal", assignee: "grace" },
              { text: "Prepare backup demo recording", assignee: "leo" },
              { text: "Configure attendee questions and moderation", assignee: "omar" },
              { text: "Write recording handoff notes", assignee: "grace" },
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
            "Build the teaching portion of the webinar around three habits for coordinating recurring client work.",
            "Use one end-to-end example, leave ten minutes for the partner workflow, and move detailed product setup into the follow-up guide.",
          ],
          dueOffsetDays: 3,
          createdBy: "omar",
          comments: [{ author: "amelia", hoursAfterCreation: 13, body: "The second section currently repeats the first with different screenshots. Use that time to show what changes when an external partner joins the board.", mentions: ["ben"] }],
        },
        {
          title: "Build the webinar registration page",
          assignee: "leo",
          description: [
            "Build the co-branded registration page with speaker details, a clear learning outcome, timezone-aware event information, and consent-safe partner attribution.",
            "Registration data should flow only to Kanera until attendees explicitly opt into partner follow-up.",
          ],
          createdBy: "omar",
          checklists: [{
            title: "Registration flow",
            items: [
              { text: "Implement co-branded header", assignee: "leo", completedBy: "leo", completedOffsetHours: 8 },
              { text: "Add timezone-aware event display", assignee: "leo" },
              { text: "Verify partner consent wording", assignee: "grace" },
              { text: "Test confirmation and calendar file", assignee: "leo" },
            ],
          }],
        },
        {
          title: "Assemble the webinar follow-up sequence",
          assignee: "grace",
          description: [
            "Build the post-webinar emails now so they are ready to send while interest is fresh: a recording link for attendees, and a separate 'you missed it' for no-shows.",
            "Only registrants who opted into partner follow-up should reach the partner's list; keep the Kanera and partner sends clearly separate.",
          ],
          createdBy: "omar",
          checklists: [{
            title: "Follow-up emails",
            items: [
              { text: "Draft attendee recording email", assignee: "grace", completedBy: "grace", completedOffsetHours: 7 },
              { text: "Draft no-show recap email", assignee: "grace" },
              { text: "Split partner-consented recipients", assignee: "omar" },
              { text: "Confirm the follow-up demo CTA with sales", assignee: "ben" },
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
            "Review the final 45-minute run of show for pace, handoffs, audience value, and recovery if the live demo fails.",
            "The partner has approved their segment. Confirm only material timing or positioning changes so the speakers can rehearse against a stable plan.",
          ],
          createdBy: "omar",
          dueOffsetDays: 2,
        },
        {
          title: "Approve the event invitation email",
          assignee: "ben",
          description: [
            "Review the invitation email against the registration page and audience list.",
            "Check that the learning promise is specific, the partner role is clear, and the message does not imply the session is customer-only when qualified prospects are included.",
          ],
          createdBy: "grace",
        },
        {
          title: "Approve the partner co-branding on the registration page",
          assignee: "amelia",
          description: [
            "Confirm the partner's logo placement, the co-branded header, and the attribution wording meet both brand guidelines before the page goes public.",
            "Leo has the partner's assets in place; this pass is about whether the two brands sit together well and the consent language reads clearly.",
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
            "Orbiflow's operations director has accepted in principle but has not confirmed the rehearsal and broadcast holds.",
            "Omar has a customer-only version of the agenda ready if the partner cannot commit by the decision date.",
          ],
          createdBy: "grace",
          dueOffsetDays: 1,
          comments: [{ author: "omar", hoursAfterCreation: 21, body: "Their assistant confirmed the broadcast hold. I am leaving this here until the rehearsal is accepted as well; that is the harder dependency.", mentions: ["grace"] }],
        },
        {
          title: "Receive partner biography and headshot",
          assignee: "grace",
          description: [
            "The registration page still uses a placeholder biography and an older low-resolution speaker image.",
            "Grace requested a 60-word biography, role confirmation, pronunciation note, and original headshot. The page can remain private until these arrive.",
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
            "Calendar holds include the production team and specify who can approve a change, preventing side conversations from moving the event.",
          ],
          createdBy: "amelia",
          createdDaysAgo: 21,
        },
        {
          title: "Previous partner session retrospective",
          assignee: "omar",
          description: [
            "The team documented attendance quality, question themes, partner handoffs, recording performance, and the follow-up work created by the previous session.",
            "The main change for autumn is a shorter demo and a single consent owner; both decisions are linked from the new webinar brief.",
          ],
          createdBy: "ben",
          createdDaysAgo: 34,
          comments: [{ author: "grace", hoursAfterCreation: 26, body: "I added the twelve registrations that arrived after the live date from the recording page. They change the follow-up total but not the attendance rate.", mentions: ["omar"] }],
        },
        {
          title: "Post-event survey questions finalised",
          assignee: "omar",
          description: [
            "The attendee survey was cut to five questions that actually change what we do next, with one open field instead of a grid of ratings.",
            "The questions match the ones the previous retrospective wished it had asked, so the two events can finally be compared.",
          ],
          createdBy: "grace",
        },
        {
          title: "Speaker thank-you notes sent",
          assignee: "grace",
          description: [
            "The guest speaker and the partner team received personal thank-you notes and the early attendance and engagement figures.",
            "Keeping the relationship warm matters more than the single event; both were invited to co-propose the spring session.",
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
            "Sales has asked for a procurement-ready version of the core deck with security, rollout, ownership, and support information in one place.",
            "Grace will collect the five slides reps currently assemble by hand and confirm whether a modular appendix solves the problem better than another full deck.",
          ],
          createdBy: "ben",
          comments: [{ author: "grace", hoursAfterCreation: 12, body: "Three reps sent examples. They all rebuild the implementation timeline and security summary; the rest of the deck is already covered.", mentions: ["ben"] }],
        },
        {
          title: "Refresh the customer onboarding email sequence",
          assignee: "zoe",
          description: [
            "Customer success wants the onboarding sequence to reflect the new workspace setup and reduce the number of separate links in the first week.",
            "Before drafting, map the current sends to actual customer milestones and identify which messages can be removed rather than rewritten.",
          ],
          createdBy: "grace",
        },
        {
          title: "Sales one-pager for the finance buyer",
          assignee: "grace",
          description: [
            "Sales keeps losing momentum when procurement pulls in a finance stakeholder who was not part of the earlier conversations.",
            "Produce a single page that frames cost, rollout effort, and ownership in the terms a finance buyer cares about, without turning into a pricing sheet.",
          ],
          createdBy: "ben",
        },
        {
          title: "Localised deck for the DACH region",
          assignee: "grace",
          description: [
            "The regional reps have been hand-translating slides, which drifts from the approved messaging and looks inconsistent in the same deal.",
            "Scope a properly localised core deck and confirm who reviews the translation before we commit; a rough machine translation is worse than English here.",
          ],
          createdBy: "amelia",
        },
        {
          title: "Refresh the support canned responses",
          assignee: "zoe",
          description: [
            "Support's saved replies still use old product names and link to two help-centre pages that were merged during the content audit.",
            "Update the wording to match the refreshed voice and fix the links; keep the replies short enough that agents still personalise them.",
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
            "Every customer story is currently laid out from scratch, which is slow and makes older stories look inconsistent next to new ones.",
            "Design one flexible template that handles a quote, a metric block, and a photo, and degrades cleanly when a story has none of those.",
          ],
          createdBy: "grace",
          labels: ["Design", "Copy & Content"],
        },
        {
          title: "Create a customer-success business review deck",
          assignee: "nina",
          description: [
            "Create a flexible business-review deck for customer success covering adoption, operating wins, open risks, and the next-quarter plan.",
            "It must work with incomplete analytics and small accounts; include honest empty states instead of forcing every customer into a growth chart.",
          ],
          createdBy: "grace",
          checklists: [{
            title: "Required layouts",
            items: [
              { text: "Executive summary", assignee: "nina" },
              { text: "Adoption with partial-data state", assignee: "nina" },
              { text: "Wins and evidence", assignee: "nina" },
              { text: "Risks, owners, and next steps", assignee: "nina" },
              { text: "Facilitator notes", assignee: "grace" },
            ],
          }],
        },
        {
          title: "Update the recruitment brochure",
          assignee: "zoe",
          description: [
            "Update the recruitment brochure with the current company story, team principles, hiring process, and benefits language supplied by HR.",
            "Keep the writing specific enough to help a candidate decide whether the environment suits them; remove generic claims that could describe any software company.",
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
            "Turn the approved product overview into a concise PDF that sales can send after an introductory call.",
            "The document should explain the workspace model, shared lists and fields, guest access, and common rollout path without pretending to be a full product manual.",
          ],
          dueOffsetDays: 8,
          createdBy: "ben",
          checklists: [{
            title: "Document sections",
            items: [
              { text: "Workspace model diagram", assignee: "nina", completedBy: "nina", completedOffsetHours: 7 },
              { text: "Shared structure example", assignee: "nina" },
              { text: "Guest-access explanation", assignee: "zoe" },
              { text: "Rollout timeline", assignee: "grace" },
              { text: "Accessible PDF export", assignee: "nina" },
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
            "Prepare the first asset set for engineering and customer-success recruitment: role cards, employee-story crops, referral image, and careers-page header.",
            "Use the refreshed brand system but keep the photography candid. HR has asked us not to retouch office backgrounds into a workplace candidates will never see.",
          ],
          createdBy: "grace",
          checklists: [{
            title: "Campaign assets",
            items: [
              { text: "Engineering role card", assignee: "nina", completedBy: "nina", completedOffsetHours: 9 },
              { text: "Customer-success role card", assignee: "nina" },
              { text: "Employee-story crops", assignee: "nina" },
              { text: "Referral image", assignee: "nina" },
              { text: "Careers-page header", assignee: "nina" },
            ],
          }],
        },
        {
          title: "Rewrite the sales presentation copy",
          assignee: "zoe",
          description: [
            "Rewrite the core sales narrative around the cost of rebuilding context across separate boards and trackers.",
            "Keep product terms accurate, give reps optional proof for different audiences, and remove the unsupported claim that setup takes less than a day.",
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
            "Review the complete PDF for product accuracy, sales usefulness, and whether each claim is supported by a visible example.",
            "Check the guest-access and rollout sections especially carefully; those are the two areas where previous materials created avoidable follow-up questions.",
          ],
          createdBy: "nina",
          dueOffsetDays: 9,
        },
        {
          title: "Approve the recruitment campaign assets",
          assignee: "amelia",
          description: [
            "Review the campaign as a candidate experience across the careers page, role cards, and employee-story posts.",
            "HR has approved the role details. Confirm that the visual tone feels credible, inclusive, and recognisably Kanera before Nina exports the final set.",
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
            "The draft procurement appendix is with three sales reps who handle different account sizes.",
            "Grace asked each reviewer to use it in a real call and report what was missing, ignored, or moved elsewhere—not simply whether they liked the design.",
          ],
          createdBy: "ben",
          comments: [{ author: "grace", hoursAfterCreation: 22, body: "Two reps have used it. Both skipped the support slide but asked for a clearer data-migration sequence; I am waiting on the enterprise call before consolidating.", mentions: ["ben", "nina"] }],
        },
        {
          title: "HR confirmation of recruitment wording",
          assignee: "zoe",
          description: [
            "HR is checking the final benefits, location, interview, and equal-opportunity wording against the live role templates.",
            "Zoe can finish the company-story sections now. No role card should be exported until HR confirms that the flexible-work language matches current policy.",
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
            "The customer-success team received the new kickoff presentation with modular agenda, responsibility map, first-month plan, and facilitator notes.",
            "Grace ran a short enablement session and linked two follow-up requests rather than expanding the template before anyone used it.",
          ],
          createdBy: "grace",
          createdDaysAgo: 18,
        },
        {
          title: "Previous sales brochure retired",
          assignee: "zoe",
          description: [
            "The outdated brochure was removed from the shared drive, sales favourites, and automated follow-up sequence.",
            "Existing links now point to a retirement notice and the current product overview, preventing old pricing and access language from continuing to circulate.",
          ],
          createdBy: "ben",
          createdDaysAgo: 29,
          comments: [{ author: "ben", hoursAfterCreation: 18, body: "I checked the three most common email templates and they all resolve to the new overview. Closing this before somebody resurrects the old PDF.", mentions: ["zoe"] }],
        },
        {
          title: "Leadership offsite slide template delivered",
          assignee: "nina",
          description: [
            "Leadership received a clean template for the quarterly offsite so the strategy narrative is not rebuilt from a copied deck each time.",
            "It covers the standard sections but leaves the content open, and it uses the refreshed brand system without looking like a customer pitch.",
          ],
          createdBy: "grace",
        },
        {
          title: "HR careers-page copy shipped",
          assignee: "zoe",
          description: [
            "The careers page now uses the specific, honest company story from the recruitment work instead of the generic 'join our journey' placeholder.",
            "HR confirmed the benefits and equal-opportunity wording against current policy before it went live.",
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
          "The shared plan for the autumn campaign launch.",
          "Ben owns launch readiness. Amelia provides final approval, while creative, content, web, events, and coordination owners keep their linked work current across the workspace.",
          "Use the hero card to demonstrate My Cards, search, completion, Work Done, and the AI one-on-one flow.",
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
        cards: autumnCampaignCards,
      },
      {
        key: "brand-refresh",
        name: "Brand Refresh",
        description: "Creative production and brand-system work for a consistent visual identity.",
        icon: "palette",
        iconColor: "violet",
        createdBy: "nina",
        cards: brandRefreshCards,
      },
      {
        key: "website-and-landing-pages",
        name: "Website & Landing Pages",
        description: "Website, landing-page, analytics, accessibility, and growth work.",
        icon: "world-www",
        iconColor: "teal",
        createdBy: "leo",
        cards: websiteCards,
      },
      {
        key: "content-and-customer-stories",
        name: "Content & Customer Stories",
        description: "Editorial, newsletter, thought-leadership, and customer-story work.",
        icon: "article",
        iconColor: "green",
        createdBy: "zoe",
        cards: contentCards,
      },
      {
        key: "events-and-partnerships",
        name: "Events & Partnerships",
        description: "Webinars, partner activity, speakers, and deadline-driven event coordination.",
        icon: "calendar-event",
        iconColor: "orange",
        createdBy: "omar",
        cards: eventsCards,
      },
      {
        key: "marketing-requests",
        name: "Marketing Requests",
        description: "Operational requests from sales, HR, leadership, and customer-facing teams.",
        icon: "inbox",
        iconColor: "gray",
        createdBy: "grace",
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
              "Exercise the rotation process in staging before we repeat it in production next month.",
              "Need updated runbook steps and a rollback note if the app rejects old tokens too early.",
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
                  { text: "Update rollback note in runbook", assignee: "grace", dueOffsetDays: 4, dueDateSlot: "morning" },
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
              "The current threshold pages too early for isolated customer connectivity issues.",
              "We want a warning before page-level noise until we have better storage segmentation.",
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
              "Realtime regressions are difficult to spot from API health alone.",
              "We need a lightweight synthetic that validates workspace and board room joins separately.",
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
              "Large attachment churn from demos has increased table bloat in the dev environment.",
              "Schedule the maintenance window and capture expected customer impact ahead of time.",
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
              "We cut default concurrency yesterday and want one more week of data before making it permanent.",
              "Watch attachment cleanup and overdue notifications closely.",
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
              "The drill should cover both local disk pressure in dev and object-store credential failure in hosted environments.",
              "Document which alerts fire first and who owns the initial response.",
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
              "The backlog cleared on its own, but we do not know whether the root cause was DB pressure or storage latency.",
              "Need one short investigation note before we close the incident.",
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
                  { text: "Attach query log excerpt from backlog window", assignee: "henry", dueOffsetDays: 0, dueDateSlot: "afternoon" },
                  { text: "Compare storage latency with queue depth", assignee: "omar", dueOffsetDays: 1, dueDateSlot: "morning" },
                  { text: "Write closing note with root-cause confidence", assignee: "grace", dueOffsetDays: 2, dueDateSlot: "afternoon" },
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
              "We have the steps scattered between tickets and docs; consolidate them into one operator-friendly runbook.",
              "The runbook should include how the encrypted config is written back.",
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
              "The load test is done, but the assumptions are still living in an ops thread.",
              "Move the current limits and expected board-room behavior into docs.",
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
              "The new seed workflow makes the local environment more valuable for demos, so we need quicker visibility into whether it is healthy.",
              "Start with DB, uploads disk, and websocket status.",
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
              "Pull the dormant admin list, confirm legitimate access, and downgrade anything stale.",
              "This is the first step before the quarterly access review closes.",
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
                  { text: "Export dormant org admin list", assignee: "henry", dueOffsetDays: 1, dueDateSlot: "morning", completedBy: "henry", completedOffsetHours: 8 },
                  { text: "Confirm legitimate exceptions with Amelia", assignee: "grace", dueOffsetDays: 2, dueDateSlot: "afternoon" },
                  { text: "Downgrade stale admin accounts", assignee: "henry", dueOffsetDays: 3, dueDateSlot: "morning" },
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
              "Audit wants screenshots and a short explanation of how workspace members differ from board guests.",
              "We should use the seeded demo environment to capture the final walkthrough.",
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
              "Compliance wants exported audit bundles to expire on a predictable schedule in the local seed and hosted environments.",
              "Need the retention copy before the admin page can expose it.",
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
              "Set the review cadence, attendee list, and evidence sources for the next privileged access review.",
              "This replaces the manual calendar process we have been using.",
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
              "The rollout is complete, but support needs a short watch period in case any customer admins are locked out.",
              "Track exception requests here rather than in email.",
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
              "List every vendor with access to infrastructure or support tools and record the review owner.",
              "We need this done before next month’s governance checkpoint.",
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
              "Several old integration tokens have not been used for months but still have elevated scopes.",
              "Review each one with support before revoking it.",
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
              "The old templates reference product concepts we no longer expose.",
              "Archive them so the team only pulls the current pack.",
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
              "Define who approves customer-facing incident language based on severity and scope.",
              "This should remove ambiguity during off-hours events.",
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
              "The policy review generated a handful of smaller actions that still need owners and due dates.",
              "Keep them on this board until they are assigned into general ops work.",
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
              { text: "Reproduce sleep/wake with two board tabs", assignee: "nina", dueOffsetDays: -3, dueDateSlot: "morning", completedBy: "nina", completedOffsetHours: 8 },
              { text: "Order workspace reconciliation before board replay", assignee: "ben", dueOffsetDays: -2, dueDateSlot: "afternoon" },
              { text: "Verify optimistic title edits survive reconnect", assignee: "ben", dueOffsetDays: -1, dueDateSlot: "morning" },
              { text: "Capture Chrome and Safari evidence", assignee: "nina", dueOffsetDays: 0, dueDateSlot: "endOfWorkDay" },
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
              { text: "Merge duplicate missing-title reports", assignee: "nina", completedBy: "nina", completedOffsetHours: 5 },
              { text: "Retest quiet-hours boundary in Sydney timezone", assignee: "ben", dueOffsetDays: -1, dueDateSlot: "afternoon" },
              { text: "Confirm badge count after sign-out and sign-in", assignee: "nina", dueOffsetDays: 0, dueDateSlot: "morning" },
              { text: "Post beta summary for support", assignee: "nina", dueOffsetDays: 1, dueDateSlot: "afternoon" },
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
              { text: "Correlate memory peaks with image mime type", assignee: "omar", dueOffsetDays: -2, completedBy: "omar", completedOffsetHours: 5 },
              { text: "Compare cover and thumbnail concurrency", assignee: "grace", dueOffsetDays: -1 },
              { text: "Run a bounded replay with production-sized images", assignee: "omar", dueOffsetDays: 0 },
              { text: "Write mitigation and rollback thresholds", assignee: "grace", dueOffsetDays: 1 },
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
              { text: "Attach source query for dormant admins", assignee: "henry", completedBy: "henry", completedOffsetHours: 4 },
              { text: "Record support confirmation for two revocations", assignee: "grace", dueOffsetDays: -2 },
              { text: "Add reviewer identity to exception decision", assignee: "henry", dueOffsetDays: -1 },
              { text: "Complete independent sign-off", assignee: "grace", dueOffsetDays: 0 },
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

function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0, 0));
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function addHours(value: Date, hours: number): Date {
  return new Date(value.getTime() + hours * 60 * 60 * 1000);
}

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60 * 1000);
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
        title: noteSeed.title,
        content: noteSeed.content,
        icon: noteSeed.icon ?? null,
        position: positionForIndex(index),
        createdAt,
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
    const href = `/b/${row.card.boardId}?cardId=${row.card.id}`;
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

async function seedDatabase(): Promise<SeedSummary> {
  await assertBlankDatabase();

  const passwordHash = await hashPassword(SHARED_PASSWORD);
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

  try {
    await db.transaction(async (tx) => {
      const storageConfig = getConfiguredS3StorageConfig() ?? { kind: "local" as const };
      const [client] = await tx
        .insert(clients)
        .values({
          name: "Happen Software",
          storageConfig,
          // Keep hosted dev seeds aligned with real hosted signup: the seeded org starts as a
          // trialing Pro org so Account settings can exercise trial, upgrade, and cancel flows.
          ...(env.KANERA_DEPLOYMENT_MODE === "hosted"
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

      storage = createStorageForConfig(client!.id, storageConfig);

      const userIdByKey = new Map<SeedUserKey, string>();
      const userTimezoneByKey = new Map<SeedUserKey, string>();
      const baseDate = startOfToday();
      for (const userSeed of USER_SEEDS) {
        const [user] = await tx
          .insert(users)
          .values({
            clientId: client!.id,
            clientRole: userSeed.clientRole,
            email: userSeed.email,
            passwordHash,
            displayName: userSeed.displayName,
            timezone: userSeed.timezone,
          })
          .returning();
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

      // A separate client makes Maya a real cross-organisation guest. Her own workspace keeps
      // normal sign-in from sending her through onboarding before she can open the shared board.
      const guestStorageConfig = { kind: "local" as const };
      const [guestClient] = await tx
        .insert(clients)
        .values({ name: "Maya Chen Consulting", storageConfig: guestStorageConfig })
        .returning();
      guestStorage = createStorageForConfig(guestClient!.id, guestStorageConfig);
      const [guestUser] = await tx
        .insert(users)
        .values({
          clientId: guestClient!.id,
          clientRole: GUEST_USER_SEED.clientRole,
          email: GUEST_USER_SEED.email,
          passwordHash,
          displayName: GUEST_USER_SEED.displayName,
          timezone: GUEST_USER_SEED.timezone,
        })
        .returning();
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
      for (const [cardIndex, cardSeed] of guestCards.entries()) {
        const listRow = guestListByName.get(cardSeed.list);
        if (!listRow) throw new Error(`Missing list '${cardSeed.list}' in Maya's workspace.`);

        const nextListCount = guestCardCountsByList.get(cardSeed.list) ?? 0;
        guestCardCountsByList.set(cardSeed.list, nextListCount + 1);
        const cardCreatedAt = addHours(guestBoardCreatedAt, 2 + cardIndex);
        const [card] = await tx
          .insert(cards)
          .values({
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
              { text: "Create an account and complete onboarding", assignee: "amelia", completedBy: "amelia", completedOffsetHours: 2 },
              { text: "Create, move, and assign a card", assignee: "amelia", completedBy: "amelia", completedOffsetHours: 3 },
              { text: "Confirm updates appear in a second browser", assignee: "amelia", dueOffsetDays: 0, dueDateSlot: "morning" },
              { text: "Verify refresh-token sign-out", assignee: "amelia", dueOffsetDays: 0, dueDateSlot: "afternoon" },
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
      for (const [cardIndex, cardSeed] of standaloneCards.entries()) {
        const listRow = standaloneListByName.get(cardSeed.list);
        if (!listRow) throw new Error(`Missing list '${cardSeed.list}' in standalone board.`);
        const listPosition = standaloneCardCountsByList.get(cardSeed.list) ?? 0;
        standaloneCardCountsByList.set(cardSeed.list, listPosition + 1);
        const completedAt = cardSeed.completedDaysAgo === undefined ? null : addHours(addDays(baseDate, -cardSeed.completedDaysAgo), 16);
        const cardCreatedAt = completedAt ? addDays(completedAt, -1) : addHours(standaloneCreatedAt, 5 + cardIndex);
        const [card] = await tx.insert(cards).values({
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
          const checklistCreatedAt = addHours(cardCreatedAt, checklistIndex + 1);
          const [checklist] = await tx.insert(cardChecklists).values({ cardId: card!.id, title: checklistSeed.title, position: positionForIndex(checklistIndex), createdAt: checklistCreatedAt, updatedAt: checklistCreatedAt }).returning();
          summary.checklists += 1;
          await tx.insert(cardChecklistItems).values(checklistSeed.items.map((item, itemIndex) => {
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
                  const movedAt = new Date(cardCreatedAt.getTime() + Math.round((spanMs * (step + 1)) / (steps + 1)));
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
                  checklistSeed.items.map((itemSeed, itemIndex) => {
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
                  const itemSeed = checklistSeed.items[itemIndex]!;
                  if (itemSeed.completedBy || itemSeed.dueOffsetDays === undefined || itemSeed.dueOffsetDays >= 0 || !itemSeed.assignee) return [];
                  return [{
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

    return summary;
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

try {
  const summary = await seedDatabase();
  console.log("dev seed complete");
  console.log(`organisation: Happen Software`);
  console.log(`users: ${summary.users}`);
  console.log(`workspaces: ${summary.workspaces}`);
  console.log(`boards: ${summary.boards}`);
  console.log(`cards: ${summary.cards}`);
  console.log(`comments: ${summary.comments}`);
  console.log(`separators: ${summary.separators}`);
  console.log(`attachments: ${summary.attachments}`);
  console.log(`card covers: ${summary.cardCovers}`);
  console.log(`card moves: ${summary.cardMoves}`);
  console.log(`notes: ${summary.notes}`);
  console.log(`internal links: ${summary.internalLinks}`);
  console.log(`mentions: ${summary.mentions}`);
  console.log(`notifications: ${summary.notifications}`);
  console.log(`shared password: ${SHARED_PASSWORD}`);
  console.log(`login emails: ${USER_SEEDS.map((user) => user.email).join(", ")}`);
  console.log(`guest login: ${GUEST_USER_SEED.email}`);
  console.log(`guest access: Mobile Experience (editor)`);
} finally {
  await pool.end();
}
