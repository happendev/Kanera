import type { WireScratchpadNote } from "@kanera/shared/events";
import { scratchpadNotes, type ScratchpadNote } from "@kanera/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db, type TxOnly as Tx } from "../../db.js";
import { forbidden, notFound } from "../../lib/errors.js";
import { assertAgentAccessAllowed } from "../../lib/mcp-policy.js";
import { signEmbeddedMediaUrls } from "../../lib/media-keys.js";

/**
 * Load a scratchpad page the requester owns.
 *
 * The ownership check is inline rather than an `assertX` helper because there is no helper for
 * user-and-org resources — `assertBoardAccess` / `assertWorkspaceAccess` both resolve authority
 * through a workspace, while a scratchpad has none. Both ownership columns are required: `user_id`
 * keeps the page private even from org admins, and `client_id` selects the owner's scratchpad for the
 * currently active organisation.
 *
 * 404-then-403 rather than a flat 404 for a foreign page: page ids are uuidv7 and never exposed to
 * anyone but their owner, so there is no id-enumeration surface to protect, and a distinguishable
 * 403 makes the privacy boundary directly assertable in tests.
 */
export async function loadOwned(id: string, auth: AuthClaims): Promise<ScratchpadNote> {
  const [note] = await db.select().from(scratchpadNotes).where(eq(scratchpadNotes.id, id)).limit(1);
  if (!note) throw notFound();
  if (note.userId !== auth.sub || note.clientId !== auth.cid) throw forbidden();
  return note;
}

/** Row-locked ownership check for writes that reconcile a page body with its attachment rows. */
export async function loadOwnedForUpdate(id: string, auth: AuthClaims, tx: Tx): Promise<ScratchpadNote> {
  const [note] = await tx
    .select()
    .from(scratchpadNotes)
    .where(eq(scratchpadNotes.id, id))
    .for("update")
    .limit(1);
  if (!note) throw notFound();
  if (note.userId !== auth.sub || note.clientId !== auth.cid) throw forbidden();
  return note;
}

/** Serialise page-list writes even when the owner has no rows for a normal row lock to acquire. */
export async function lockScratchpadForWrite(userId: string, clientId: string, tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`scratchpad:${userId}:${clientId}`}, 0))`);
}

/**
 * Re-sign the media URLs embedded in the page body.
 *
 * Signed from the page's own `client_id`. Access checks guarantee it matches the requester's active
 * organisation, while using the row here keeps this serializer correct outside a request context.
 */
export function wire(note: ScratchpadNote): WireScratchpadNote {
  return { ...note, content: signEmbeddedMediaUrls(note.content, note.clientId) ?? "" };
}

/**
 * A workspace key authenticates as its creator, so without this it would read and write that
 * person's private pages for anyone holding the shared key. Only credentials that act as the owner
 * themselves (a session, a personal key, or an OAuth agent grant) reach the scratchpad.
 */
export function assertPersonalCredential(claims: AuthClaims): void {
  if (claims.authKind === "apiKey" && claims.apiKeyKind !== "personal") {
    throw forbidden("the scratchpad needs a personal API key or OAuth connection");
  }
  // The scratchpad lives in the credential's current organisation, so its MCP policy governs it.
  assertAgentAccessAllowed(claims);
}

/** Millisecond-precision match between a client's ISO watermark and the stored timestamp. */
export function sameInstant(a: Date | string, b: Date | string): boolean {
  const base = new Date(a).getTime();
  const value = new Date(b).getTime();
  return value >= base && value < base + 1;
}

export function taskLine(text: string): string {
  // One capture is one list item: line breaks would start new blocks and escape the task list.
  return `- [ ] ${text.replace(/\s*\n\s*/gu, " ")}`;
}

/** Append a task, separating it from a preceding paragraph so Markdown keeps it a task list. */
export function appendTask(content: string, line: string): string {
  const trimmed = content.replace(/\s+$/u, "");
  if (trimmed === "") return line;
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  return `${trimmed}${/^\s*[-*] \[[ xX]\] /u.test(lastLine) ? "\n" : "\n\n"}${line}`;
}
