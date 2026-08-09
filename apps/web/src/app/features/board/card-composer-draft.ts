import { STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { hasMarkdownContent } from "../../shared/markdown-content";
import type { DueDateSlot } from "./due-date.util";

/**
 * One field's staged value, shaped like the `PUT /cards/:id/custom-fields/:fieldId` body so the
 * composer can hand it straight to the API without a second translation step.
 */
export interface ComposerCustomFieldValue {
  valueText?: string;
  valueNumber?: number;
  valueCheckbox?: boolean;
  valueDate?: string;
  valueUrl?: string;
  valueOptionIds?: string[];
  valueUserIds?: string[];
}

export interface CardComposerDraft {
  title: string;
  description: string;
  /**
   * Only meaningful for a draft stored under a key that is not itself a board id — Global Work
   * composes across boards, so its single draft has to remember which board it was aimed at.
   */
  boardId: string;
  listId: string;
  labelIds: string[];
  assigneeIds: string[];
  dueDateLocalDate: string;
  dueDateSlot: DueDateSlot;
  checklistTemplateIds: string[];
  customFields: Record<string, ComposerCustomFieldValue>;
  completed: boolean;
  savedAt: number;
}

/**
 * Drafts older than this are dropped on read. A composer draft is a half-typed thought, not a
 * document: resurrecting one a fortnight later is noise, and it would silently pre-fill fields the
 * user has long forgotten setting.
 */
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function emptyComposerDraft(): CardComposerDraft {
  return {
    title: "",
    description: "",
    boardId: "",
    listId: "",
    labelIds: [],
    assigneeIds: [],
    dueDateLocalDate: "",
    dueDateSlot: "anyTime",
    checklistTemplateIds: [],
    customFields: {},
    completed: false,
    savedAt: 0,
  };
}

/**
 * Whether a draft holds anything worth restoring. A draft carrying only a seeded list (which the
 * composer sets itself the moment it opens) is not user work, so it never triggers the resume banner
 * and never survives a close. The description is editor-serialised markdown, so blank lines and hard
 * breaks have to be discounted the same way an all-spaces title is.
 */
export function draftHasContent(draft: CardComposerDraft): boolean {
  return Boolean(
    draft.title.trim()
    || hasMarkdownContent(draft.description)
    || draft.labelIds.length
    || draft.assigneeIds.length
    || draft.dueDateLocalDate
    || draft.checklistTemplateIds.length
    || Object.keys(draft.customFields).length,
  );
}

/**
 * Drafts live in one map rather than one key per scope: a user with a hundred boards would otherwise
 * leave a hundred keys behind, and nothing ever enumerates them to clean up. The key is the board id
 * for a board composer, or a fixed surface key for a cross-board one such as Global Work.
 */
export function readComposerDraft(key: string): CardComposerDraft | null {
  const all = readAll();
  const draft = all[key];
  if (!draft) return null;
  if (Date.now() - draft.savedAt > DRAFT_TTL_MS) {
    writeComposerDraft(key, null);
    return null;
  }
  return draft;
}

export function writeComposerDraft(key: string, draft: CardComposerDraft | null): void {
  const all = readAll();
  if (draft && draftHasContent(draft)) all[key] = { ...draft, savedAt: Date.now() };
  else delete all[key];
  write(all);
}

function readAll(): Record<string, CardComposerDraft> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CARD_COMPOSER_DRAFTS);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, CardComposerDraft> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const draft = coerceDraft(value);
      if (draft) result[key] = draft;
    }
    return result;
  } catch {
    // Malformed or unreadable storage behaves as "no drafts" rather than blocking the composer.
    return {};
  }
}

function write(all: Record<string, CardComposerDraft>): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (Object.keys(all).length === 0) localStorage.removeItem(STORAGE_KEYS.CARD_COMPOSER_DRAFTS);
    else localStorage.setItem(STORAGE_KEYS.CARD_COMPOSER_DRAFTS, JSON.stringify(all));
  } catch {
    // ignore — quota or privacy mode
  }
}

/**
 * Storage is untrusted input: it can be hand-edited, and it survives across app versions that
 * changed this shape. Every field is re-derived with a typed fallback so a partial or stale entry
 * restores what it can rather than throwing inside the composer's constructor.
 */
function coerceDraft(value: unknown): CardComposerDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const draft: CardComposerDraft = {
    ...emptyComposerDraft(),
    title: typeof obj["title"] === "string" ? obj["title"] : "",
    description: typeof obj["description"] === "string" ? obj["description"] : "",
    boardId: typeof obj["boardId"] === "string" ? obj["boardId"] : "",
    listId: typeof obj["listId"] === "string" ? obj["listId"] : "",
    labelIds: stringArray(obj["labelIds"]),
    assigneeIds: stringArray(obj["assigneeIds"]),
    dueDateLocalDate: typeof obj["dueDateLocalDate"] === "string" ? obj["dueDateLocalDate"] : "",
    dueDateSlot: isSlot(obj["dueDateSlot"]) ? obj["dueDateSlot"] : "anyTime",
    checklistTemplateIds: stringArray(obj["checklistTemplateIds"]),
    customFields: customFields(obj["customFields"]),
    completed: obj["completed"] === true,
    savedAt: typeof obj["savedAt"] === "number" ? obj["savedAt"] : 0,
  };
  return draft;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isSlot(value: unknown): value is DueDateSlot {
  return value === "anyTime" || value === "morning" || value === "afternoon" || value === "endOfWorkDay";
}

function customFields(value: unknown): Record<string, ComposerCustomFieldValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, ComposerCustomFieldValue> = {};
  for (const [fieldId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const staged: ComposerCustomFieldValue = {};
    if (typeof entry["valueText"] === "string") staged.valueText = entry["valueText"];
    if (typeof entry["valueNumber"] === "number") staged.valueNumber = entry["valueNumber"];
    if (typeof entry["valueCheckbox"] === "boolean") staged.valueCheckbox = entry["valueCheckbox"];
    if (typeof entry["valueDate"] === "string") staged.valueDate = entry["valueDate"];
    if (typeof entry["valueUrl"] === "string") staged.valueUrl = entry["valueUrl"];
    if (Array.isArray(entry["valueOptionIds"])) staged.valueOptionIds = stringArray(entry["valueOptionIds"]);
    if (Array.isArray(entry["valueUserIds"])) staged.valueUserIds = stringArray(entry["valueUserIds"]);
    if (Object.keys(staged).length > 0) result[fieldId] = staged;
  }
  return result;
}
