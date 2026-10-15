import type { WireCardChecklist } from "@kanera/shared/events";
import { cardChecklistItems, cardChecklists } from "@kanera/shared/schema";
import { asc, eq, inArray } from "drizzle-orm";
import { db, type Tx } from "../db.js";

export async function loadChecklistsForCards(cardIds: readonly string[], tx: Tx = db): Promise<Map<string, WireCardChecklist[]>> {
  // A transaction handle uses one pg client; keep its queries sequential.
  const checklistRows = await tx.select().from(cardChecklists).where(inArray(cardChecklists.cardId, cardIds)).orderBy(asc(cardChecklists.cardId), asc(cardChecklists.position));
  const itemRows = await tx
    .select({ item: cardChecklistItems, checklistId: cardChecklistItems.checklistId })
    .from(cardChecklistItems)
    .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
    .where(inArray(cardChecklists.cardId, cardIds))
    .orderBy(asc(cardChecklists.cardId), asc(cardChecklists.position), asc(cardChecklistItems.position));
  const itemsByChecklist = new Map<string, typeof cardChecklistItems.$inferSelect[]>();
  for (const row of itemRows) {
    const items = itemsByChecklist.get(row.checklistId);
    if (items) items.push(row.item);
    else itemsByChecklist.set(row.checklistId, [row.item]);
  }
  const checklistsByCard = new Map<string, WireCardChecklist[]>();
  for (const checklist of checklistRows) {
    const checklists = checklistsByCard.get(checklist.cardId) ?? [];
    checklists.push({ ...checklist, items: itemsByChecklist.get(checklist.id) ?? [] });
    checklistsByCard.set(checklist.cardId, checklists);
  }
  return checklistsByCard;
}

export async function loadChecklistsForCard(cardId: string, tx: Tx = db): Promise<WireCardChecklist[]> {
  return (await loadChecklistsForCards([cardId], tx)).get(cardId) ?? [];
}
