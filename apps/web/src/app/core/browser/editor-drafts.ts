import { Injectable } from "@angular/core";
import { STORAGE_KEYS } from "./browser-contracts";

export type EditorDraftKind = "card-description" | "checklist-item-description" | "comment-new" | "comment-edit" | "note-body";

export interface EditorDraft {
  key: string;
  userId: string;
  kind: EditorDraftKind;
  entityId: string;
  markdown: string;
  baseMarkdown: string;
  updatedAt: string;
  cardId?: string;
  commentId?: string;
  noteId?: string;
}

export interface EditorDraftInput {
  userId: string | null | undefined;
  kind: EditorDraftKind;
  entityId: string;
  markdown: string;
  baseMarkdown: string;
  cardId?: string;
  commentId?: string;
  noteId?: string;
}

type DraftStore = Record<string, EditorDraft>;

const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable({ providedIn: "root" })
export class EditorDrafts {
  keyFor(userId: string | null | undefined, kind: EditorDraftKind, entityId: string): string | null {
    if (!userId || !entityId) return null;
    return `${kind}:${userId}:${entityId}`;
  }

  load(userId: string | null | undefined, kind: EditorDraftKind, entityId: string): EditorDraft | null {
    const key = this.keyFor(userId, kind, entityId);
    if (!key) return null;
    const store = this.readStore();
    const draft = store[key] ?? null;
    if (!draft || !this.isActive(draft)) return null;
    return draft;
  }

  save(input: EditorDraftInput): EditorDraft | null {
    const key = this.keyFor(input.userId, input.kind, input.entityId);
    if (!key) return null;
    if (!this.hasChanges(input.markdown, input.baseMarkdown)) {
      this.clear(input.userId, input.kind, input.entityId);
      return null;
    }

    const draft: EditorDraft = {
      key,
      userId: input.userId!,
      kind: input.kind,
      entityId: input.entityId,
      markdown: input.markdown,
      baseMarkdown: input.baseMarkdown,
      updatedAt: new Date().toISOString(),
      cardId: input.cardId,
      commentId: input.commentId,
      noteId: input.noteId,
    };
    const store = this.readStore();
    store[key] = draft;
    this.writeStore(store);
    return draft;
  }

  clear(userId: string | null | undefined, kind: EditorDraftKind, entityId: string): void {
    const key = this.keyFor(userId, kind, entityId);
    if (!key) return;
    const store = this.readStore();
    if (!(key in store)) return;
    delete store[key];
    this.writeStore(store);
  }

  isActive(draft: Pick<EditorDraft, "markdown" | "baseMarkdown" | "updatedAt">): boolean {
    if (!this.hasChanges(draft.markdown, draft.baseMarkdown)) return false;
    return Date.now() - new Date(draft.updatedAt).getTime() <= DRAFT_MAX_AGE_MS;
  }

  private hasChanges(markdown: string, baseMarkdown: string): boolean {
    return markdown.trim() !== baseMarkdown.trim();
  }

  private readStore(): DraftStore {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.EDITOR_DRAFTS) ?? "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return this.prune(parsed as DraftStore);
    } catch {
      return {};
    }
  }

  private writeStore(store: DraftStore): void {
    try {
      const pruned = this.prune(store);
      localStorage.setItem(STORAGE_KEYS.EDITOR_DRAFTS, JSON.stringify(pruned));
    } catch {
      // Draft recovery is best-effort; full/private storage must not break editing.
    }
  }

  private prune(store: DraftStore): DraftStore {
    const now = Date.now();
    const next: DraftStore = {};
    for (const [key, draft] of Object.entries(store)) {
      if (!this.isDraft(draft)) continue;
      if (now - new Date(draft.updatedAt).getTime() > DRAFT_MAX_AGE_MS) continue;
      next[key] = draft;
    }
    if (Object.keys(next).length !== Object.keys(store).length) {
      try {
        localStorage.setItem(STORAGE_KEYS.EDITOR_DRAFTS, JSON.stringify(next));
      } catch {
        // Ignore write failures while pruning; callers still receive the usable subset.
      }
    }
    return next;
  }

  private isDraft(value: unknown): value is EditorDraft {
    if (!value || typeof value !== "object") return false;
    const draft = value as Partial<EditorDraft>;
    return typeof draft.key === "string"
      && typeof draft.userId === "string"
      && typeof draft.kind === "string"
      && typeof draft.entityId === "string"
      && typeof draft.markdown === "string"
      && typeof draft.baseMarkdown === "string"
      && typeof draft.updatedAt === "string"
      && !Number.isNaN(new Date(draft.updatedAt).getTime());
  }
}
