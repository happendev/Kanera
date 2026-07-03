import { DEFAULT_WORKSPACE_CUSTOM_FIELDS } from "@kanera/shared/default-workspace-custom-fields";
import { DEFAULT_WORKSPACE_LABELS } from "@kanera/shared/default-workspace-labels";
import type { ColorToken } from "@kanera/shared/colors";
import {
  activityEvents,
  boardSeparators,
  boardMembers,
  boards,
  cardAssignees,
  cardAttachments,
  cardChecklistItems,
  cardChecklists,
  cardCustomFieldValues,
  cardLabelAssignments,
  cardLabels,
  cards,
  clients,
  comments,
  customFields,
  internalLinks,
  lists,
  noteAttachments,
  notes,
  users,
  webhookDeliveries,
  webhookEndpoints,
  workspaceMembers,
  workspaces,
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
import { generateCoverImage, generateThumbnail, isProcessableImage } from "../lib/image.js";
import { unsignedMediaUrl } from "../lib/media-keys.js";
import { encryptSecret } from "../lib/secrets.js";
import { createStorageForConfig, getConfiguredS3StorageConfig, type StorageProvider } from "../lib/storage/index.js";
import {
  attachmentCoverStorageKey,
  attachmentThumbnailStorageKey,
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

type SeedUser = {
  key: SeedUserKey;
  email: string;
  displayName: string;
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
  color?: string;
};

type SeedCustomField = {
  name: string;
  icon?: string;
  type: "text" | "number" | "checkbox";
  showOnCard?: boolean;
};

type SeedLabel = {
  name: string;
  color: string;
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
  completedBy?: SeedUserKey;
  completedDaysAgo?: number;
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
  iconColor: string;
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
  accentColor: string;
  createdBy: SeedUserKey;
  members: SeedMember[];
  lists: SeedList[];
  customFields: SeedCustomField[];
  labels: SeedLabel[];
  notes?: SeedNote[];
  boards: SeedBoard[];
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
  notes: number;
  internalLinks: number;
  webhookEndpoints: number;
  webhookDeliveries: number;
};

type SeedNotesResult = {
  notes: number;
  attachments: number;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../..");
const SHARED_PASSWORD = "Abc12345";

const ATTACHMENT_ASSETS = {
  venusPhoto: {
    relativePath: ["images", "checking-out-venus.jpg"],
    mimeType: "image/jpeg",
  },
  nightlightPhoto: {
    relativePath: ["images", "pixls-nightlight.jpg"],
    mimeType: "image/jpeg",
  },
  earthPoster: {
    relativePath: ["images", "solar-system-portrait-earth.jpg"],
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
  missionGuide: {
    relativePath: ["pdfs", "engineering-onboarding-checklist.pdf"],
    mimeType: "application/pdf",
  },
  architectureRecord: {
    relativePath: ["docx", "architecture-decision-record.docx"],
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  aiStrategy: {
    relativePath: ["docx", "release-readiness-template.docx"],
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
  { key: "amelia", email: "amelia@kanera.test", displayName: "Amelia Hart", timezone: "Europe/London", clientRole: "owner" },
  { key: "marcus", email: "marcus@kanera.test", displayName: "Marcus Cole", timezone: "America/New_York", clientRole: "admin" },
  { key: "priya", email: "priya@kanera.test", displayName: "Priya Nair", timezone: "Europe/London", clientRole: "member" },
  { key: "ben", email: "ben@kanera.test", displayName: "Ben Ortega", timezone: "America/Los_Angeles", clientRole: "member" },
  { key: "nina", email: "nina@kanera.test", displayName: "Nina Park", timezone: "America/Chicago", clientRole: "member" },
  { key: "zoe", email: "zoe@kanera.test", displayName: "Zoe Mitchell", timezone: "Australia/Sydney", clientRole: "member" },
  { key: "leo", email: "leo@kanera.test", displayName: "Leo Santos", timezone: "America/Sao_Paulo", clientRole: "member" },
  { key: "omar", email: "omar@kanera.test", displayName: "Omar Ibrahim", timezone: "Africa/Cairo", clientRole: "member" },
  { key: "grace", email: "grace@kanera.test", displayName: "Grace Liu", timezone: "Asia/Singapore", clientRole: "member" },
  { key: "henry", email: "henry@kanera.test", displayName: "Henry Walsh", timezone: "Europe/Dublin", clientRole: "member" },
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
  timezone: "America/Toronto",
  clientRole: "owner",
};

function note(...sections: string[]): string {
  return sections.join("\n\n");
}

function buildWorkspaceSeeds(): SeedWorkspace[] {
  return [buildDevelopmentWorkspace(), buildMarketingWorkspace(), buildDevopsWorkspace()];
}

function buildDevelopmentWorkspace(): SeedWorkspace {
  return {
    key: "development",
    name: "Development",
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
    customFields: DEFAULT_WORKSPACE_CUSTOM_FIELDS.map((field) => ({ ...field })),
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
            attachments: [{ asset: "architectureRecord", uploadedBy: "priya" }],
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
            fieldValues: { Branch: "feature/kan-184-workspace-templates", "Billing Hours": 11.5, "Billing Month": "2026-05" },
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
            fieldValues: { Branch: "fix/kan-201-export-retry", "Billing Hours": 6, "Billing Month": "2026-05" },
            attachments: [{ asset: "apiRolloutPlan", uploadedBy: "omar" }],
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
            fieldValues: { Branch: "feature/kan-193-board-hydration", "Billing Hours": 13, "Billing Month": "2026-05" },
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
            fieldValues: { Branch: "feature/kan-196-mobile-notifications", "Billing Hours": 8.5, "Billing Month": "2026-06" },
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
            fieldValues: { Branch: "test/onboarding-no-workspace", "Billing Hours": 4, "Billing Month": "2026-05" },
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
            fieldValues: { Branch: "spike/changelog-from-activity", "Billing Hours": 3, "Billing Month": "2026-06" },
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
            fieldValues: { Branch: "fix/orphaned-attachment-cleanup", "Billing Hours": 7.25, "Billing Month": "2026-05" },
            attachments: [{ asset: "nightlightPhoto", uploadedBy: "omar", useAsCover: true }],
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
            fieldValues: { Branch: "feature/sla-summary-widget", "Billing Hours": 5.5, "Billing Month": "2026-05" },
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
            fieldValues: { Branch: "chore/comment-composer-a11y", "Billing Hours": 4.5, "Billing Month": "2026-05" },
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
            fieldValues: { Branch: "docs/branching-guide-refresh", "Billing Hours": 2, "Billing Month": "2026-05" },
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
            fieldValues: { Branch: "feature/mobile-offline-skeleton", "Billing Hours": 6.5, "Billing Month": "2026-05" },
            attachments: [{ asset: "venusPhoto", uploadedBy: "ben", useAsCover: true }],
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
            fieldValues: { Branch: "fix/ios-reminder-title", "Billing Hours": 7, "Billing Month": "2026-05" },
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
            fieldValues: { Branch: "feature/tablet-board-overview", "Billing Hours": 9, "Billing Month": "2026-06" },
            attachments: [{ asset: "orbiflowLogo", uploadedBy: "zoe", useAsCover: true }],
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
            fieldValues: { Branch: "spike/mobile-auth-telemetry", "Billing Hours": 2.5, "Billing Month": "2026-06" },
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
            fieldValues: { Branch: "test/mobile-web-attachments", "Billing Hours": 5, "Billing Month": "2026-05" },
            attachments: [{ asset: "earthPoster", uploadedBy: "nina", useAsCover: true }],
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
            fieldValues: { Branch: "spike/mobile-card-swipes", "Billing Hours": 4, "Billing Month": "2026-06" },
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
            fieldValues: { Branch: "fix/android-chip-line-height", "Billing Hours": 3.5, "Billing Month": "2026-05" },
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
            fieldValues: { Branch: "feature/mobile-build-info", "Billing Hours": 2.5, "Billing Month": "2026-05" },
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
            fieldValues: { Branch: "copy/mobile-upload-progress", "Billing Hours": 1.5, "Billing Month": "2026-05" },
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
            fieldValues: { Branch: "docs/mobile-push-troubleshooting", "Billing Hours": 2, "Billing Month": "2026-05" },
            attachments: [{ asset: "onboardingChecklist", uploadedBy: "grace" }],
          },
        ],
      },
    ],
  };
}

function buildMarketingWorkspace(): SeedWorkspace {
  return {
    key: "marketing",
    name: "Marketing",
    icon: "speakerphone",
    accentColor: "rose",
    createdBy: "marcus",
    members: [
      { user: "marcus", role: "owner" },
      { user: "zoe", role: "admin" },
      { user: "leo", role: "editor" },
      { user: "amelia", role: "owner" },
      { user: "ben", role: "observer" },
    ],
    lists: [
      { name: "Ideas", icon: "bulb" },
      { name: "Briefing", icon: "clipboard" },
      { name: "Drafting", icon: "pencil" },
      { name: "Design Review", icon: "eye" },
      { name: "Scheduled", icon: "calendar-event" },
      { name: "Live", icon: "broadcast" },
      { name: "Measuring", icon: "chart-bar" },
      { name: "Done", icon: "circle-check" },
    ],
    customFields: [
      { name: "Audience", icon: "users", type: "text" },
      { name: "Budget", icon: "cash", type: "number" },
      { name: "Launch Window", icon: "calendar-event", type: "text" },
    ],
    labels: [
      { name: "Campaign", color: "blue" },
      { name: "Content", color: "green" },
      { name: "Paid", color: "amber" },
      { name: "Website", color: "teal" },
      { name: "Partner", color: "violet" },
    ],
    notes: [
      {
        title: "Campaign Launch Playbook",
        icon: "speakerphone",
        owner: "zoe",
        content: note(
          "🚀 Reusable launch process for campaign boards.",
          "Start with a brief, agree the audience and budget custom fields, move creative through design review, and keep measurement cards open until we can compare opens, replies, and demo requests.",
          "For demos, search `campaign launch` to show how notes and cards share the same workspace context.",
          "Campaign calendar: https://marketing.kanera.test/q3-launch-calendar",
        ),
      },
      {
        title: "Partner Demo Talk Track",
        icon: "presentation",
        owner: "marcus",
        content: note(
          "Short talk track for partner-facing reviews.",
          "Lead with workspace-scoped boards, lists, and fields, then explain how external guests can be limited to specific boards.",
          "Close by searching across cards, notes, comments, and files so the partner sees how launch context stays discoverable.",
          "Demo script: https://marketing.kanera.test/partner-demo-talk-track",
        ),
      },
    ],
    boards: [
      {
        key: "q3-demand-generation",
        name: "Q3 Demand Generation",
        description: "Shared calendar for campaigns, content production, launch timing, and post-launch reporting.",
        icon: "rocket",
        iconColor: "rose",
        createdBy: "zoe",
        notes: [
          {
            title: "Reliability Launch Messaging Brief",
            icon: "message-2-star",
            owner: "zoe",
            content: note(
              "Campaign-specific messaging for the platform reliability launch.",
              "Lead with reduced admin time, fewer missed follow-ups, and clearer ownership. Avoid internal incident language unless it supports a customer-facing proof point.",
              "Assets needed: one product screenshot, one customer quote placeholder, and a paid social variant that can stand alone without webinar context.",
              "- 🖼️ Product screenshot\n- 💬 Customer quote placeholder\n- 📣 Paid social variant",
            ),
          },
          {
            title: "Webinar Follow-up Cadence",
            icon: "mail-forward",
            owner: "leo",
            content: note(
              "Follow-up plan for Q3 demand generation webinars.",
              "Send the replay within 24 hours, route partner leads to Marcus, and tag product-template interest separately from reliability interest so measurement does not blur the campaign signal.",
              "Registration page: https://events.kanera.test/workflow-templates-webinar",
            ),
          },
        ],
        cards: [
          {
            title: "Finalize campaign brief for platform reliability launch",
            description: note(
              "The brief should package the reliability story in customer language, not internal incident language.",
              "Need messaging, CTA hierarchy, and a clear handoff to paid social.",
            ),
            list: "Briefing",
            createdBy: "zoe",
            assignees: ["zoe", "leo"],
            labels: ["Campaign", "Content"],
            dueOffsetDays: 3,
            dueDateSlot: "afternoon",
            fieldValues: { Audience: "Operations leaders", Budget: 12000, "Launch Window": "June week 2" },
            attachments: [{ asset: "sprintforgeLogo", uploadedBy: "leo", useAsCover: true }],
            checklists: [
              {
                title: "Brief approvals",
                items: [
                  { text: "Rewrite proof points in customer language", assignee: "zoe", dueOffsetDays: 1, dueDateSlot: "afternoon", completedBy: "zoe", completedOffsetHours: 10 },
                  { text: "Confirm CTA order with partner sales", assignee: "leo", dueOffsetDays: 2, dueDateSlot: "morning" },
                  { text: "Hand off paid social angles", assignee: "leo", dueOffsetDays: 3, dueDateSlot: "afternoon" },
                ],
              },
            ],
            comments: [
              { author: "marcus", hoursAfterCreation: 8, body: "Please keep the proof points tied to reduced admin time, not just system uptime." },
            ],
          },
          {
            title: "Draft landing page copy for workflow templates",
            description: note(
              "Target customers who need structure quickly and do not want to design workflows from scratch.",
              "The first draft should include a shorter hero and one concrete example workspace.",
            ),
            list: "Drafting",
            createdBy: "leo",
            assignees: ["leo", "zoe"],
            labels: ["Website", "Content"],
            dueOffsetDays: 6,
            dueDateSlot: "endOfWorkDay",
            fieldValues: { Audience: "Small software teams", Budget: 6000, "Launch Window": "June week 3" },
            comments: [
              { author: "amelia", hoursAfterCreation: 10, body: "Use realistic workspace examples from engineering, marketing, and ops. That story is landing well in demos." },
            ],
          },
          {
            title: "Review paid social creative options",
            description: note(
              "Compare static image treatments against a short product-led walkthrough clip.",
              "We only need enough creative to validate channel fit this cycle.",
            ),
            list: "Design Review",
            createdBy: "zoe",
            assignees: ["zoe", "leo"],
            labels: ["Paid", "Campaign"],
            dueOffsetDays: 8,
            fieldValues: { Audience: "Founders and product leads", Budget: 9000, "Launch Window": "July week 1" },
            attachments: [{ asset: "northstarLogo", uploadedBy: "leo" }],
          },
          {
            title: "Lock webinar registration flow",
            description: note(
              "Need form copy, routing, and follow-up cadence before ads can point at it.",
              "Support wants the confirmation email to set clear expectations about the live demo format.",
            ),
            list: "Scheduled",
            createdBy: "marcus",
            assignees: ["zoe"],
            labels: ["Campaign", "Partner"],
            dueOffsetDays: 10,
            dueDateSlot: "morning",
            fieldValues: { Audience: "RevOps teams", Budget: 4500, "Launch Window": "June week 4" },
            checklists: [
              {
                title: "Registration flow",
                items: [
                  { text: "Finalize form fields and routing owner", assignee: "zoe", dueOffsetDays: 4, dueDateSlot: "afternoon" },
                  { text: "Draft confirmation email copy", assignee: "leo", dueOffsetDays: 5, dueDateSlot: "morning" },
                  { text: "Run test registration through webinar tool", assignee: "zoe", dueOffsetDays: 8, dueDateSlot: "endOfWorkDay" },
                ],
              },
            ],
            comments: [
              { author: "leo", hoursAfterCreation: 12, body: "I can mock the confirmation flow once we settle the CTA language." },
            ],
          },
          {
            title: "Publish customer story teaser on social",
            description: note(
              "This teaser should lead into the longer website case study without revealing the customer name yet.",
              "Need approval on the screenshot set first.",
            ),
            list: "Live",
            createdBy: "zoe",
            assignees: ["zoe"],
            labels: ["Content", "Campaign"],
            dueOffsetDays: 1,
            dueDateSlot: "afternoon",
            fieldValues: { Audience: "Existing trial users", Budget: 2000, "Launch Window": "This week" },
            comments: [
              { author: "marcus", hoursAfterCreation: 4, body: "Once this is live, flag support so they know where incoming trial traffic is coming from." },
            ],
          },
          {
            title: "Measure nurture email open-rate changes",
            description: note(
              "We changed subject lines and trimmed the body copy last week.",
              "Look at opens, replies, and demo requests together instead of isolating one metric.",
            ),
            list: "Measuring",
            createdBy: "leo",
            assignees: ["leo", "marcus"],
            labels: ["Content"],
            dueOffsetDays: 5,
            fieldValues: { Audience: "Free trial accounts", Budget: 1500, "Launch Window": "Ongoing" },
            attachments: [{ asset: "aiStrategy", uploadedBy: "leo" }],
          },
          {
            title: "Build the June launch calendar",
            description: note(
              "Pull website, social, webinar, and partner steps into one calendar view with explicit owners.",
              "This replaces the spreadsheet the team has been sharing in email.",
            ),
            list: "Ideas",
            createdBy: "zoe",
            assignees: ["zoe", "marcus"],
            labels: ["Campaign"],
            dueOffsetDays: 11,
            fieldValues: { Audience: "Internal planning", Budget: 0, "Launch Window": "June" },
          },
          {
            title: "Refresh homepage customer proof strip",
            description: note(
              "Use the stronger product screenshots and update the copy to focus on shared workflow clarity.",
              "Engineering wants a content freeze two days before the next deploy window.",
            ),
            list: "Design Review",
            createdBy: "leo",
            assignees: ["leo", "zoe"],
            labels: ["Website"],
            dueOffsetDays: 7,
            dueDateSlot: "endOfWorkDay",
            fieldValues: { Audience: "Website visitors", Budget: 3000, "Launch Window": "June week 2" },
            comments: [
              { author: "ben", hoursAfterCreation: 9, body: "If we change the image aspect ratio, I need the final asset export before code freeze." },
            ],
          },
          {
            title: "Archive old partner copy references",
            description: note(
              "Remove the outdated messaging that still references the older product hierarchy.",
              "Partner-facing docs should match the workspace-first model everywhere.",
            ),
            list: "Done",
            createdBy: "marcus",
            assignees: ["zoe"],
            labels: ["Partner", "Content"],
            dueOffsetDays: -5,
            fieldValues: { Audience: "Partners", Budget: 0, "Launch Window": "Completed" },
          },
          {
            title: "Prepare launch retrospective prompts",
            description: note(
              "Write the questions we want answered after the campaign closes so measurement stays focused.",
              "Keep the prompts short enough to use in a 30 minute debrief.",
            ),
            list: "Done",
            createdBy: "zoe",
            assignees: ["zoe", "leo"],
            labels: ["Campaign"],
            dueOffsetDays: -2,
            fieldValues: { Audience: "Internal planning", Budget: 0, "Launch Window": "Post-launch" },
            attachments: [{ asset: "retroNotes", uploadedBy: "zoe" }],
          },
        ],
      },
      {
        key: "partner-launch-reviews",
        name: "Partner Launch Reviews",
        description: "Board for partner-specific launch plans, approvals, and executive review notes.",
        icon: "users-group",
        iconColor: "amber",
        createdBy: "marcus",
        members: [
          { user: "marcus", role: "owner" },
          { user: "zoe", role: "admin" },
          { user: "leo", role: "editor" },
          { user: "amelia", role: "owner" },
        ],
        notes: [
          {
            title: "Northstar Approval Notes",
            icon: "building-community",
            owner: "marcus",
            content: note(
              "Private approval notes for the Northstar co-marketing timeline.",
              "Keep executive review, screenshot approval, and shared asset ownership in this board because the timing is partner-sensitive.",
              "Do not move copy to public campaign docs until Northstar approves the teaser date.",
              "Partner portal: https://partners.kanera.test/northstar",
            ),
          },
          {
            title: "Partner Page Legal Copy",
            icon: "scale",
            owner: "zoe",
            content: note(
              "Working notes for partner page legal language.",
              "Current risk areas: customer data handling, regional hosting claims, and avoiding roadmap promises for features that are still in pilot.",
            ),
          },
        ],
        cards: [
          {
            title: "Approve Northstar co-marketing timeline",
            description: note(
              "Northstar wants the case study teaser one week before the live event.",
              "We need internal sign-off on the timeline and who owns the shared assets folder.",
            ),
            list: "Briefing",
            createdBy: "marcus",
            assignees: ["marcus", "zoe"],
            labels: ["Partner", "Campaign"],
            dueOffsetDays: 2,
            dueDateSlot: "afternoon",
            fieldValues: { Audience: "Existing partner leads", Budget: 5000, "Launch Window": "June week 2" },
            attachments: [{ asset: "northstarLogo", uploadedBy: "leo" }],
            comments: [
              { author: "amelia", hoursAfterCreation: 7, body: "Please make sure the partner timeline still leaves engineering enough review time for the screenshots." },
            ],
          },
          {
            title: "Draft Orbiflow launch email",
            description: note(
              "Orbiflow wants a direct announcement email plus one reminder on the morning of the webinar.",
              "The message should avoid promising features still in pilot.",
            ),
            list: "Drafting",
            createdBy: "zoe",
            assignees: ["zoe", "leo"],
            labels: ["Partner", "Content"],
            dueOffsetDays: 5,
            fieldValues: { Audience: "Orbiflow customer list", Budget: 2500, "Launch Window": "June week 4" },
            attachments: [{ asset: "orbiflowLogo", uploadedBy: "leo", useAsCover: true }],
          },
          {
            title: "Review legal notes for partner page copy",
            description: note(
              "The partner page needs updated phrasing around customer data handling and regional hosting.",
              "Legal wants the final copy before the page is scheduled.",
            ),
            list: "Design Review",
            createdBy: "marcus",
            assignees: ["marcus"],
            labels: ["Partner", "Website"],
            dueOffsetDays: 4,
            dueDateSlot: "morning",
            fieldValues: { Audience: "Prospective partners", Budget: 1800, "Launch Window": "June week 3" },
            comments: [
              { author: "zoe", hoursAfterCreation: 10, body: "I have a redline draft ready once the compliance wording is final." },
            ],
          },
          {
            title: "Schedule Sprintforge asset review",
            description: note(
              "Sprintforge wants a tight turn on video thumbnails and event banners.",
              "We should review their assets before asking design to resize anything.",
            ),
            list: "Scheduled",
            createdBy: "leo",
            assignees: ["leo", "zoe"],
            labels: ["Partner", "Campaign"],
            dueOffsetDays: 6,
            fieldValues: { Audience: "Sprintforge audience", Budget: 3200, "Launch Window": "July week 1" },
            attachments: [{ asset: "sprintforgeLogo", uploadedBy: "leo" }],
          },
          {
            title: "Launch private preview registration page",
            description: note(
              "This page is for partner reps only and should not be linked from the main site navigation.",
              "Add a short explanation of who the preview is for before the form.",
            ),
            list: "Live",
            createdBy: "zoe",
            assignees: ["zoe", "leo"],
            labels: ["Partner", "Website"],
            dueOffsetDays: 1,
            fieldValues: { Audience: "Partner reps", Budget: 2200, "Launch Window": "This week" },
          },
          {
            title: "Measure partner referral conversions",
            description: note(
              "Break down demo requests by referral source and landing page variant.",
              "Finance also wants the estimated CAC by partner after week one.",
            ),
            list: "Measuring",
            createdBy: "marcus",
            assignees: ["marcus", "zoe"],
            labels: ["Partner", "Paid"],
            dueOffsetDays: 9,
            fieldValues: { Audience: "Internal review", Budget: 0, "Launch Window": "July week 1" },
            attachments: [{ asset: "missionGuide", uploadedBy: "marcus" }],
          },
          {
            title: "Build shared FAQ for partner asks",
            description: note(
              "Support and partner managers need one approved answer bank for common launch questions.",
              "Keep it short enough to paste into email threads.",
            ),
            list: "Ideas",
            createdBy: "amelia",
            assignees: ["zoe", "marcus"],
            labels: ["Partner", "Content"],
            dueOffsetDays: 7,
            fieldValues: { Audience: "Partner managers", Budget: 0, "Launch Window": "June" },
          },
          {
            title: "Refresh shared launch checklist",
            description: note(
              "The current checklist still references the pre-workspace product language.",
              "Partner teams will use this during rehearsals, so clarity matters.",
            ),
            list: "Done",
            createdBy: "zoe",
            assignees: ["zoe"],
            labels: ["Partner", "Content"],
            dueOffsetDays: -4,
            fieldValues: { Audience: "Partner teams", Budget: 0, "Launch Window": "Completed" },
            attachments: [{ asset: "onboardingChecklist", uploadedBy: "zoe" }],
          },
          {
            title: "Close out legacy partner asset requests",
            description: note(
              "Archive requests for the old screenshots so they stop surfacing in weekly reviews.",
              "We only want currently approved assets in rotation.",
            ),
            list: "Done",
            createdBy: "leo",
            assignees: ["leo"],
            labels: ["Partner"],
            dueOffsetDays: -6,
            fieldValues: { Audience: "Internal cleanup", Budget: 0, "Launch Window": "Completed" },
          },
          {
            title: "Prep executive note for partner kickoff",
            description: note(
              "Write the short note Marcus will send before the kickoff call to align on goals and timing.",
              "Keep the tone warm but operational.",
            ),
            list: "Drafting",
            createdBy: "marcus",
            assignees: ["marcus"],
            labels: ["Partner", "Content"],
            dueOffsetDays: 3,
            fieldValues: { Audience: "Partner executives", Budget: 0, "Launch Window": "June week 2" },
          },
        ],
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
            attachments: [{ asset: "earthPoster", uploadedBy: "grace", useAsCover: true }],
          },
          {
            title: "Prepare June database vacuum window",
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
            attachments: [{ asset: "missionGuide", uploadedBy: "amelia" }],
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
  await linkCardToNote("Finalize campaign brief for platform reliability launch", "Reliability Launch Messaging Brief");
  await linkNoteToCard("Campaign Launch Playbook", "Finalize campaign brief for platform reliability launch");
  await linkCardToNote("Approve Northstar co-marketing timeline", "Northstar Approval Notes");
  await linkNoteToCard("Northstar Approval Notes", "Approve Northstar co-marketing timeline");

  if (rows.length === 0) return 0;
  await tx.insert(internalLinks).values(rows).onConflictDoNothing();
  return rows.length;
}

// Seeds only use text/number/checkbox fields; `fieldType` is the broad DB enum.
function fieldValueUpdate(fieldType: string, value: SeedFieldValue) {
  const base = { valueText: null, valueNumber: null, valueCheckbox: null } as {
    valueText: string | null;
    valueNumber: string | null;
    valueCheckbox: boolean | null;
  };
  if (fieldType === "text") return { ...base, valueText: String(value) };
  if (fieldType === "number") return { ...base, valueNumber: String(value) };
  return { ...base, valueCheckbox: Boolean(value) };
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

  if (isProcessableImage(assetMeta.mimeType)) {
    const thumbnailBuffer = await generateThumbnail(buffer);
    thumbnailFileKey = attachmentThumbnailStorageKey(fileKey);
    await input.storage.put(thumbnailFileKey, thumbnailBuffer, "image/jpeg");
    input.uploadedKeys.push(thumbnailFileKey);
    thumbnailUrl = unsignedMediaUrl(input.clientId, thumbnailFileKey);

    if (input.shouldGenerateCover) {
      const coverBuffer = await generateCoverImage(buffer);
      coverImageFileKey = attachmentCoverStorageKey(fileKey);
      await input.storage.put(coverImageFileKey, coverBuffer, "image/jpeg");
      input.uploadedKeys.push(coverImageFileKey);
      coverImageUrl = unsignedMediaUrl(input.clientId, coverImageFileKey);
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
      source: "attachment",
      commentId: null,
      createdAt: input.createdAt,
    })
    .returning();

  return attachment!;
}

async function seedWebhookDeliveryDemos(input: {
  tx: Tx;
  workspaceId: string;
  createdById: string;
  baseDate: Date;
}): Promise<{ endpoints: number; deliveries: number }> {
  const firstDeliveryAt = addHours(input.baseDate, 10);
  const [automationEndpoint, incidentEndpoint] = await input.tx
    .insert(webhookEndpoints)
    .values([
      {
        workspaceId: input.workspaceId,
        createdById: input.createdById,
        name: "Automation relay",
        url: "https://example.test/kanera/automation",
        encryptedSecret: encryptSecret("seed-automation-webhook-secret"),
        eventTypes: ["card:created", "card:moved", "comment:created"],
        enabled: true,
        createdAt: addHours(input.baseDate, 8),
        updatedAt: addHours(input.baseDate, 8),
      },
      {
        workspaceId: input.workspaceId,
        createdById: input.createdById,
        name: "Incident audit mirror",
        url: "https://example.test/kanera/incidents",
        encryptedSecret: encryptSecret("seed-incident-webhook-secret"),
        eventTypes: ["card:updated", "card:deleted"],
        enabled: false,
        createdAt: addHours(input.baseDate, 9),
        updatedAt: addHours(input.baseDate, 9),
      },
    ])
    .returning();

  if (!automationEndpoint || !incidentEndpoint) return { endpoints: 0, deliveries: 0 };

  const deliveryRows: (typeof webhookDeliveries.$inferInsert)[] = [
    {
      endpointId: automationEndpoint.id,
      workspaceId: input.workspaceId,
      eventType: "card:created",
      payload: {
        id: "seed-card-created-001",
        type: "card:created",
        workspaceId: input.workspaceId,
        occurredAt: addMinutes(firstDeliveryAt, -45).toISOString(),
        data: { title: "Roll out project templates to new workspaces", source: "seed" },
      },
      status: "success",
      attempts: 1,
      lastAttemptAt: addMinutes(firstDeliveryAt, -44),
      responseStatus: 204,
      responseBody: "",
      lastError: null,
      deliveredAt: addMinutes(firstDeliveryAt, -44),
      nextAttemptAt: addMinutes(firstDeliveryAt, -44),
      createdAt: addMinutes(firstDeliveryAt, -45),
      updatedAt: addMinutes(firstDeliveryAt, -44),
    },
    {
      endpointId: automationEndpoint.id,
      workspaceId: input.workspaceId,
      eventType: "comment:created",
      payload: {
        id: "seed-comment-created-001",
        type: "comment:created",
        workspaceId: input.workspaceId,
        occurredAt: addMinutes(firstDeliveryAt, -25).toISOString(),
        data: { body: "Can we include webhook history in the release notes?", source: "seed" },
      },
      status: "queued",
      attempts: 1,
      lastAttemptAt: addMinutes(firstDeliveryAt, -24),
      responseStatus: 503,
      responseBody: "maintenance window",
      lastError: "HTTP 503",
      deliveredAt: null,
      nextAttemptAt: addHours(new Date(), 6),
      createdAt: addMinutes(firstDeliveryAt, -25),
      updatedAt: addMinutes(firstDeliveryAt, -24),
    },
    {
      endpointId: automationEndpoint.id,
      workspaceId: input.workspaceId,
      eventType: "card:moved",
      payload: {
        id: "seed-card-moved-001",
        type: "card:moved",
        workspaceId: input.workspaceId,
        occurredAt: addMinutes(firstDeliveryAt, -5).toISOString(),
        data: { title: "Sync integration docs with public API changes", source: "seed" },
      },
      status: "delivering",
      attempts: 2,
      lastAttemptAt: addMinutes(firstDeliveryAt, -5),
      responseStatus: null,
      responseBody: null,
      lastError: null,
      deliveredAt: null,
      nextAttemptAt: addHours(new Date(), 6),
      createdAt: addMinutes(firstDeliveryAt, -5),
      updatedAt: addMinutes(firstDeliveryAt, -4),
    },
    {
      endpointId: incidentEndpoint.id,
      workspaceId: input.workspaceId,
      eventType: "card:updated",
      payload: {
        id: "seed-card-updated-001",
        type: "card:updated",
        workspaceId: input.workspaceId,
        occurredAt: addMinutes(firstDeliveryAt, -90).toISOString(),
        data: { title: "Tune alert noise for failed attachment uploads", source: "seed" },
      },
      status: "failed",
      attempts: 8,
      lastAttemptAt: addMinutes(firstDeliveryAt, -30),
      responseStatus: null,
      responseBody: null,
      lastError: "fetch failed",
      deliveredAt: null,
      nextAttemptAt: addMinutes(firstDeliveryAt, -30),
      createdAt: addMinutes(firstDeliveryAt, -90),
      updatedAt: addMinutes(firstDeliveryAt, -30),
    },
  ];

  await input.tx.insert(webhookDeliveries).values(deliveryRows);
  return { endpoints: 2, deliveries: deliveryRows.length };
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
    notes: 0,
    internalLinks: 0,
    webhookEndpoints: 0,
    webhookDeliveries: 0,
  };
  const uploadedKeys: string[] = [];
  const assetCache = new Map<AssetKey, Buffer>();
  let storage: StorageProvider | null = null;

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
        userIdByKey.set(userSeed.key, user!.id);
        userTimezoneByKey.set(userSeed.key, userSeed.timezone);
        summary.users += 1;
      }

      // A separate client makes Maya a real cross-organisation guest. Her own workspace keeps
      // normal sign-in from sending her through onboarding before she can open the shared board.
      const [guestClient] = await tx
        .insert(clients)
        .values({ name: "Maya Chen Consulting", storageConfig: { kind: "local" } })
        .returning();
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
      userIdByKey.set(GUEST_USER_SEED.key, guestUser!.id);
      userTimezoneByKey.set(GUEST_USER_SEED.key, GUEST_USER_SEED.timezone);
      summary.users += 1;

      const [guestWorkspace] = await tx
        .insert(workspaces)
        .values({
          clientId: guestClient!.id,
          name: "Maya's Workspace",
          icon: "briefcase",
          accentColor: "violet",
        })
        .returning();
      await tx.insert(workspaceMembers).values({
        workspaceId: guestWorkspace!.id,
        userId: guestUser!.id,
        role: "admin",
      });
      summary.workspaces += 1;

      const baseDate = startOfToday();

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
            const completedAt = cardSeed.completedDaysAgo === undefined
              ? null
              : addHours(addDays(baseDate, -cardSeed.completedDaysAgo), 16);
            const cardCreatedAt = completedAt
              ? addDays(completedAt, -7)
              : addHours(addDays(boardCreatedAt, cardIndex), cardIndex % 5);
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

            await recordActivity(tx, {
              boardId: board!.id,
              workspaceId: workspace!.id,
              actorId: userIdByKey.get(cardSeed.createdBy)!,
              entityType: "card",
              entityId: card!.id,
              action: "created",
              payload: { title: cardSeed.title, listId: listRow.id },
            });

            if (completedAt) {
              if (!cardSeed.completedBy) throw new Error(`Completed card '${cardSeed.title}' needs completedBy.`);
              // Seed the matching audit row at the historical time; recordActivity intentionally
              // uses the current time and therefore cannot represent old completion history.
              await tx.insert(activityEvents).values({
                boardId: board!.id,
                workspaceId: workspace!.id,
                actorId: userIdByKey.get(cardSeed.completedBy)!,
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
                    ...fieldValueUpdate(fieldRow.type, value),
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

              await recordActivity(tx, {
                boardId: board!.id,
                workspaceId: workspace!.id,
                actorId: userIdByKey.get(cardSeed.createdBy)!,
                entityType: "card",
                entityId: card!.id,
                action: "checklist:created",
                payload: { cardId: card!.id, checklistId: checklist!.id, title: checklistSeed.title },
              });

              if (checklistSeed.items.length > 0) {
                const invalidItemAssignees = checklistSeed.items
                  .map((item) => item.assignee)
                  .filter((assignee): assignee is SeedUserKey => assignee !== undefined && !assignableMemberKeys.has(assignee));
                if (invalidItemAssignees.length > 0) {
                  throw new Error(`Checklist '${checklistSeed.title}' assigns non-assignable members: ${invalidItemAssignees.join(", ")}`);
                }

                await tx.insert(cardChecklistItems).values(
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
                );
                summary.checklistItems += checklistSeed.items.length;
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

              await recordActivity(tx, {
                boardId: board!.id,
                workspaceId: workspace!.id,
                actorId: userIdByKey.get(attachmentSeed.uploadedBy)!,
                entityType: "card",
                entityId: card!.id,
                action: "attachment_added",
                payload: {
                  cardId: card!.id,
                  attachmentId: attachment.id,
                  fileName: attachment.fileName,
                  mimeType: attachment.mimeType,
                  source: attachment.source,
                },
              });
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
              const [comment] = await tx
                .insert(comments)
                .values({
                  cardId: card!.id,
                  authorId: userIdByKey.get(commentSeed.author)!,
                  body: commentSeed.body,
                  createdAt: commentCreatedAt,
                })
                .returning();
              summary.comments += 1;
              latestCardTimestamp = commentCreatedAt > latestCardTimestamp ? commentCreatedAt : latestCardTimestamp;

              await recordActivity(tx, {
                boardId: board!.id,
                workspaceId: workspace!.id,
                actorId: userIdByKey.get(commentSeed.author)!,
                entityType: "comment",
                entityId: comment!.id,
                action: "created",
                payload: { cardId: card!.id },
              });
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
        if (workspaceSeed.key === "development") {
          const webhooks = await seedWebhookDeliveryDemos({
            tx,
            workspaceId: workspace!.id,
            createdById: userIdByKey.get(workspaceSeed.createdBy)!,
            baseDate: addDays(workspaceCreatedAt, 2),
          });
          summary.webhookEndpoints += webhooks.endpoints;
          summary.webhookDeliveries += webhooks.deliveries;
        }
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
  console.log(`notes: ${summary.notes}`);
  console.log(`internal links: ${summary.internalLinks}`);
  console.log(`webhook endpoints: ${summary.webhookEndpoints}`);
  console.log(`webhook deliveries: ${summary.webhookDeliveries}`);
  console.log(`shared password: ${SHARED_PASSWORD}`);
  console.log(`login emails: ${USER_SEEDS.map((user) => user.email).join(", ")}`);
  console.log(`guest login: ${GUEST_USER_SEED.email}`);
  console.log(`guest access: Mobile Experience (editor)`);
} finally {
  await pool.end();
}
