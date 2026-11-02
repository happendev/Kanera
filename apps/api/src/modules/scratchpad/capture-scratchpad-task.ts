import type { dto } from "@kanera/shared";
import { MAX_SCRATCHPAD_NOTES, scratchpadNotes, type ScratchpadNote } from "@kanera/shared/schema";
import { and, asc, eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { badRequest } from "../../lib/errors.js";
import { between } from "../../lib/position.js";
import { appendTask, lockScratchpadForWrite, taskLine } from "./route-support.js";

/**
 * Quick capture for "remind me to…" without choosing a board: appends one open task to the named
 * page (default "Inbox"), creating it at the end of the tab list when absent. The append happens
 * under the page's row lock, so it can never drop an edit that landed between an agent's read and
 * write the way a client-side read-modify-write would.
 */
export async function captureScratchpadTask({
  auth,
  body,
}: {
  auth: AuthClaims;
  body: dto.CaptureScratchpadItemBody;
}): Promise<{ note: ScratchpadNote; created: boolean; line: string }> {
  const line = taskLine(body.text);

  const { note, created } = await db.transaction(async (tx) => {
    await lockScratchpadForWrite(auth.sub, auth.cid, tx);
    const pages = await tx
      .select()
      .from(scratchpadNotes)
      .where(and(eq(scratchpadNotes.userId, auth.sub), eq(scratchpadNotes.clientId, auth.cid)))
      .for("update")
      .orderBy(asc(scratchpadNotes.position));
    // Titles are free text and need not be unique; the first matching tab is the inbox.
    const page = pages.find((row) => row.title.trim().toLowerCase() === body.pageTitle.toLowerCase());
    if (page) {
      const [updated] = await tx
        .update(scratchpadNotes)
        .set({ content: appendTask(page.content, line), updatedAt: new Date() })
        .where(eq(scratchpadNotes.id, page.id))
        .returning();
      return { note: updated!, created: false };
    }
    if (pages.length >= MAX_SCRATCHPAD_NOTES) {
      throw badRequest(`a scratchpad holds at most ${MAX_SCRATCHPAD_NOTES} pages; capture to an existing page title`);
    }
    const { position } = between(pages.at(-1)?.position ?? null, null);
    const [inserted] = await tx
      .insert(scratchpadNotes)
      .values({ userId: auth.sub, clientId: auth.cid, title: body.pageTitle, content: line, position })
      .returning();
    return { note: inserted!, created: true };
  });

  return { note, created, line };
}
