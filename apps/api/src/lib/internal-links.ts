import type { BacklinkSummary, LinkedInternalSummary } from "@kanera/shared/dto";
import { boards, cards, internalLinks, lists, notes, type InternalLinkSourceType, type InternalLinkTargetType, type Note } from "@kanera/shared/schema";
import { and, eq, inArray, like, or } from "drizzle-orm";
import type { AuthClaims } from "../auth/plugin.js";
import { db } from "../db.js";
import { env } from "../env.js";
import { assertBoardAccess, assertCardAccess, assertWorkspaceAccess } from "./access.js";

const UUID = "[0-9a-fA-F-]{36}";
const URL_RE = new RegExp(`(?:https?:\\/\\/[^\\/\\s)<>]+)?(?:\\/b\\/${UUID}(?:\\/c\\/${UUID})?|\\/w\\/${UUID}\\/notes)(?:[?#][^\\s)<>]*)?`, "g");
const BOARD_PATH_RE = /^\/b\/([0-9a-fA-F-]{36})(?:\/)?$/;
const CARD_PATH_RE = /^\/b\/([0-9a-fA-F-]{36})\/c\/([0-9a-fA-F-]{36})(?:\/)?$/;
const WORKSPACE_NOTES_PATH_RE = /^\/w\/([0-9a-fA-F-]{36})\/notes(?:\/)?$/;
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Tx;

export type ParsedInternalLink =
  | { kind: "board"; boardId: string; href: string }
  | { kind: "card"; boardId: string; cardId: string; href: string }
  | { kind: "note"; workspaceId: string; boardId: string | null; noteId: string; href: string };

function isLoopbackOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function isAllowedInternalOrigin(origin: string): boolean {
  const webOrigin = new URL(env.WEB_ORIGIN).origin;
  if (origin === webOrigin) return true;
  // Dev servers may move between localhost/127.0.0.1 or ports. Treat those as
  // the same app only when the configured web origin is also loopback.
  return isLoopbackOrigin(webOrigin) && isLoopbackOrigin(origin);
}

export function parseInternalUrl(raw: string): ParsedInternalLink | null {
  let url: URL;
  try {
    url = new URL(raw, env.WEB_ORIGIN);
  } catch {
    return null;
  }

  if (!isAllowedInternalOrigin(url.origin)) return null;

  const cardMatch = CARD_PATH_RE.exec(url.pathname);
  if (cardMatch) {
    const [, boardId, cardId] = cardMatch;
    return { kind: "card", boardId: boardId!, cardId: cardId!, href: `${url.pathname}${url.search}${url.hash}` };
  }

  const boardMatch = BOARD_PATH_RE.exec(url.pathname);
  if (boardMatch) {
    const [, boardId] = boardMatch;
    const noteId = url.searchParams.get("noteId");
    if (url.searchParams.get("view") === "notes" && noteId && UUID_RE.test(noteId)) {
      return { kind: "note", workspaceId: "", boardId: boardId!, noteId, href: `${url.pathname}${url.search}${url.hash}` };
    }
    const cardId = url.searchParams.get("cardId");
    if (cardId && UUID_RE.test(cardId)) {
      return { kind: "card", boardId: boardId!, cardId, href: `${url.pathname}${url.search}${url.hash}` };
    }
    if (cardId || noteId) return null;
    return { kind: "board", boardId: boardId!, href: `${url.pathname}${url.search}${url.hash}` };
  }

  const workspaceNoteMatch = WORKSPACE_NOTES_PATH_RE.exec(url.pathname);
  if (workspaceNoteMatch) {
    const [, workspaceId] = workspaceNoteMatch;
    const noteId = url.searchParams.get("noteId");
    if (!noteId || !UUID_RE.test(noteId)) return null;
    return { kind: "note", workspaceId: workspaceId!, boardId: null, noteId, href: `${url.pathname}${url.search}${url.hash}` };
  }

  return null;
}

export function extractInternalUrls(markdown: string | null | undefined): string[] {
  if (!markdown) return [];
  // Markdown autolinks (`<https://...>`) and ordinary prose punctuation can
  // sit directly beside a URL. Keep those delimiters out of persistence so
  // URLSearchParams sees the intended ids instead of `noteId=...>`.
  return [...new Set([...markdown.matchAll(URL_RE)].map((match) => match[0]!.replace(/[.,!?;:]+$/g, "")))];
}

async function targetForParsed(claims: AuthClaims, parsed: ParsedInternalLink, workspaceId: string, tx: DbLike) {
  try {
    if (parsed.kind === "board") {
      const ctx = await assertBoardAccess(claims, parsed.boardId);
      if (ctx.workspaceId !== workspaceId) return null;
      return { targetType: "board" as const, targetId: parsed.boardId };
    }
    if (parsed.kind === "card") {
      const ctx = await assertCardAccess(claims, parsed.cardId);
      if (ctx.workspaceId !== workspaceId || ctx.boardId !== parsed.boardId) return null;
      const [card] = await tx.select({ id: cards.id }).from(cards).where(and(eq(cards.id, parsed.cardId), eq(cards.boardId, parsed.boardId))).limit(1);
      return card ? { targetType: "card" as const, targetId: card.id } : null;
    }

    const [note] = await tx.select().from(notes).where(eq(notes.id, parsed.noteId)).limit(1);
    if (!note || note.workspaceId !== workspaceId) return null;
    if (parsed.boardId && note.boardId !== parsed.boardId) return null;
    if (!parsed.boardId && parsed.workspaceId && note.workspaceId !== parsed.workspaceId) return null;
    if (!(await canReadNote(claims, note))) return null;
    return { targetType: "note" as const, targetId: note.id };
  } catch {
    return null;
  }
}

export async function replaceInternalLinksForSource(params: {
  tx: DbLike;
  claims: AuthClaims;
  workspaceId: string;
  sourceType: InternalLinkSourceType;
  sourceId: string;
  markdown: string | null | undefined;
}) {
  const { tx, claims, workspaceId, sourceType, sourceId, markdown } = params;
  const targets = new Map<string, { targetType: InternalLinkTargetType; targetId: string }>();
  for (const raw of extractInternalUrls(markdown)) {
    const parsed = parseInternalUrl(raw);
    if (!parsed) continue;
    const target = await targetForParsed(claims, parsed, workspaceId, tx);
    if (!target) continue;
    if (target.targetType === sourceType && target.targetId === sourceId) continue;
    targets.set(`${target.targetType}:${target.targetId}`, target);
  }

  const existing = await tx
    .select({ targetType: internalLinks.targetType, targetId: internalLinks.targetId })
    .from(internalLinks)
    .where(and(eq(internalLinks.sourceType, sourceType), eq(internalLinks.sourceId, sourceId)));
  const existingKeys = new Set(existing.map((link) => `${link.targetType}:${link.targetId}`));

  // Detail and backlink reads call repair as a self-healing path, so unchanged
  // sources must avoid delete/reinsert churn on the read hot path.
  if (existingKeys.size === targets.size && [...targets.keys()].every((key) => existingKeys.has(key))) return;

  await tx.delete(internalLinks).where(and(eq(internalLinks.sourceType, sourceType), eq(internalLinks.sourceId, sourceId)));

  if (!targets.size) return;
  await tx.insert(internalLinks).values([...targets.values()].map((target) => ({
    workspaceId,
    sourceType,
    sourceId,
    targetType: target.targetType,
    targetId: target.targetId,
  }))).onConflictDoNothing();
}

export async function canReadNote(claims: AuthClaims, note: Pick<Note, "workspaceId" | "boardId" | "scope" | "ownerId">): Promise<boolean> {
  try {
    if (note.boardId) await assertBoardAccess(claims, note.boardId, "observer");
    else await assertWorkspaceAccess(claims, note.workspaceId, "member");
    return note.scope === "team" || note.ownerId === claims.sub;
  } catch {
    return false;
  }
}

export async function loadLinkedNotesForCard(claims: AuthClaims, cardId: string, workspaceId: string): Promise<LinkedInternalSummary[]> {
  const noteRows = await db
    .select({
      note: notes,
      boardName: boards.name,
    })
    .from(internalLinks)
    .innerJoin(notes, or(
      and(eq(internalLinks.sourceType, "card"), eq(internalLinks.sourceId, cardId), eq(internalLinks.targetType, "note"), eq(internalLinks.targetId, notes.id)),
      and(eq(internalLinks.sourceType, "note"), eq(internalLinks.targetType, "card"), eq(internalLinks.targetId, cardId), eq(internalLinks.sourceId, notes.id)),
    ))
    .leftJoin(boards, eq(boards.id, notes.boardId))
    .where(eq(internalLinks.workspaceId, workspaceId));

  const cardRows = await db
    .select({
      id: cards.id,
      title: cards.title,
      boardId: boards.id,
      boardName: boards.name,
      boardIcon: boards.icon,
      boardIconColor: boards.iconColor,
      listName: lists.name,
    })
    .from(internalLinks)
    .innerJoin(cards, or(
      and(eq(internalLinks.sourceType, "card"), eq(internalLinks.sourceId, cardId), eq(internalLinks.targetType, "card"), eq(internalLinks.targetId, cards.id)),
      and(eq(internalLinks.sourceType, "card"), eq(internalLinks.targetType, "card"), eq(internalLinks.targetId, cardId), eq(internalLinks.sourceId, cards.id)),
    ))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .where(eq(internalLinks.workspaceId, workspaceId));

  const seen = new Set<string>();
  const summaries: LinkedInternalSummary[] = [];
  for (const row of noteRows) {
    if (seen.has(`note:${row.note.id}`) || !(await canReadNote(claims, row.note))) continue;
    seen.add(`note:${row.note.id}`);
    summaries.push({
      kind: "note",
      id: row.note.id,
      title: row.note.title,
      workspaceId: row.note.workspaceId,
      boardId: row.note.boardId,
      boardName: row.boardName,
      scope: row.note.scope,
      icon: row.note.icon,
      color: row.note.color,
    });
  }

  for (const row of cardRows) {
    if (row.id === cardId || seen.has(`card:${row.id}`)) continue;
    try {
      await assertCardAccess(claims, row.id, "observer");
      seen.add(`card:${row.id}`);
      summaries.push({
        kind: "card",
        id: row.id,
        title: row.title,
        boardId: row.boardId,
        boardName: row.boardName,
        listName: row.listName,
        icon: row.boardIcon,
        iconColor: row.boardIconColor,
      });
    } catch {
      // Related cards follow the same non-leaking board access rule as link resolution.
    }
  }

  return summaries.sort((a, b) => (a.title || "Untitled").localeCompare(b.title || "Untitled"));
}

export async function repairInternalLinksAroundCard(claims: AuthClaims, cardId: string, workspaceId: string): Promise<void> {
  const [card] = await db.select({ id: cards.id, boardId: cards.boardId, description: cards.description }).from(cards).where(eq(cards.id, cardId)).limit(1);
  if (card) {
    try {
      await assertCardAccess(claims, card.id, "observer");
      await replaceInternalLinksForSource({ tx: db, claims, workspaceId, sourceType: "card", sourceId: card.id, markdown: card.description });
    } catch {
      // Detail reads should not leak or fail because a repair candidate is inaccessible.
    }
  }

  const noteCandidates = await db.select().from(notes).where(and(eq(notes.workspaceId, workspaceId), like(notes.content, `%${cardId}%`)));
  for (const note of noteCandidates) {
    if (!(await canReadNote(claims, note))) continue;
    await replaceInternalLinksForSource({ tx: db, claims, workspaceId, sourceType: "note", sourceId: note.id, markdown: note.content });
  }
}

export async function repairInternalLinksAroundNote(claims: AuthClaims, note: Note): Promise<void> {
  const cardCandidates = await db
    .select({ id: cards.id, boardId: cards.boardId, description: cards.description })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(and(eq(boards.workspaceId, note.workspaceId), like(cards.description, `%${note.id}%`)));
  for (const card of cardCandidates) {
    try {
      await assertCardAccess(claims, card.id, "observer");
      await replaceInternalLinksForSource({ tx: db, claims, workspaceId: note.workspaceId, sourceType: "card", sourceId: card.id, markdown: card.description });
    } catch {
      // Backlink reads should only repair sources visible to the viewer.
    }
  }

  const noteCandidates = await db.select().from(notes).where(and(eq(notes.workspaceId, note.workspaceId), like(notes.content, `%${note.id}%`)));
  for (const candidate of noteCandidates) {
    if (!(await canReadNote(claims, candidate))) continue;
    await replaceInternalLinksForSource({ tx: db, claims, workspaceId: note.workspaceId, sourceType: "note", sourceId: candidate.id, markdown: candidate.content });
  }
}

export async function loadBacklinksForNote(claims: AuthClaims, note: Note): Promise<BacklinkSummary[]> {
  const rows = await db.select().from(internalLinks).where(and(eq(internalLinks.workspaceId, note.workspaceId), eq(internalLinks.targetType, "note"), eq(internalLinks.targetId, note.id)));
  const cardIds = rows.filter((r) => r.sourceType === "card").map((r) => r.sourceId);
  const noteIds = rows.filter((r) => r.sourceType === "note").map((r) => r.sourceId);
  const backlinks: BacklinkSummary[] = [];

  if (cardIds.length) {
    const cardRows = await db.select({
      id: cards.id,
      title: cards.title,
      boardId: boards.id,
      boardName: boards.name,
      boardIcon: boards.icon,
      boardIconColor: boards.iconColor,
      listName: lists.name,
    }).from(cards).innerJoin(boards, eq(boards.id, cards.boardId)).innerJoin(lists, eq(lists.id, cards.listId)).where(inArray(cards.id, cardIds));
    for (const row of cardRows) {
      try {
        await assertCardAccess(claims, row.id, "observer");
        backlinks.push({ kind: "card", id: row.id, title: row.title, boardId: row.boardId, boardName: row.boardName, listName: row.listName, icon: row.boardIcon, iconColor: row.boardIconColor });
      } catch {
        // Backlinks follow the same non-leaking access rule as link resolution.
      }
    }
  }

  if (noteIds.length) {
    const noteRows = await db.select({ note: notes, boardName: boards.name }).from(notes).leftJoin(boards, eq(boards.id, notes.boardId)).where(inArray(notes.id, noteIds));
    for (const row of noteRows) {
      if (!(await canReadNote(claims, row.note))) continue;
      backlinks.push({ kind: "note", id: row.note.id, title: row.note.title, workspaceId: row.note.workspaceId, boardId: row.note.boardId, boardName: row.boardName, scope: row.note.scope, icon: row.note.icon, color: row.note.color });
    }
  }

  return backlinks.sort((a, b) => a.title.localeCompare(b.title));
}
