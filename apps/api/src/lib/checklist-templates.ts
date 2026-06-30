import type { WireCardChecklist, WireChecklistTemplate } from "@kanera/shared/events";
import {
  type ActivityEvent,
  cardChecklistItems,
  cardChecklists,
  cardChecklistTemplateApplications,
  checklistTemplateItems,
  checklistTemplates,
} from "@kanera/shared/schema";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, type Db } from "../db.js";
import { recordActivity } from "./activity.js";
import { between } from "./position.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Load a single template with its items + bound list ids, shaped for the wire. */
export async function loadChecklistTemplate(
  templateId: string,
  tx: Tx = db,
): Promise<WireChecklistTemplate | null> {
  const [template] = await tx.select().from(checklistTemplates).where(eq(checklistTemplates.id, templateId)).limit(1);
  if (!template) return null;
  const items = await tx
    .select()
    .from(checklistTemplateItems)
    .where(eq(checklistTemplateItems.templateId, templateId))
    .orderBy(asc(checklistTemplateItems.position));
  return { ...template, items };
}

/** Load all active templates for a workspace, ordered by position. */
export async function loadChecklistTemplates(
  workspaceId: string,
  tx: Tx = db,
): Promise<WireChecklistTemplate[]> {
  const templates = await tx
    .select()
    .from(checklistTemplates)
    .where(and(eq(checklistTemplates.workspaceId, workspaceId), isNull(checklistTemplates.archivedAt)))
    .orderBy(asc(checklistTemplates.position));
  if (templates.length === 0) return [];
  const templateIds = templates.map((t) => t.id);
  const items = await tx
    .select()
    .from(checklistTemplateItems)
    .where(inArray(checklistTemplateItems.templateId, templateIds))
    .orderBy(asc(checklistTemplateItems.position));
  const itemsByTemplate = new Map<string, typeof items>();
  for (const item of items) {
    const list = itemsByTemplate.get(item.templateId);
    if (list) list.push(item);
    else itemsByTemplate.set(item.templateId, [item]);
  }
  return templates.map((template) => ({
    ...template,
    items: itemsByTemplate.get(template.id) ?? [],
  }));
}

export interface AppliedTemplateChecklist {
  templateId: string;
  checklist: WireCardChecklist;
  activity: ActivityEvent;
}

/**
 * Seed the card with any templates bound to `listId` that have not already been
 * applied to this card. Runs inside the caller's transaction; returns the created
 * checklists + their activity events so the caller can emit realtime events after
 * the transaction commits.
 *
 * Dedup is enforced via the card_checklist_template_application ledger, which
 * persists even if the seeded checklist is later deleted, so a template is never
 * applied to the same card twice.
 */
export async function applyChecklistTemplates(
  tx: Tx,
  opts: { cardId: string; boardId: string; workspaceId: string; actorId: string | null; templateIds: string[]; automationActionId?: string | null },
): Promise<AppliedTemplateChecklist[]> {
  const { cardId, boardId, workspaceId, actorId, automationActionId } = opts;
  const requestedIds = Array.from(new Set(opts.templateIds));
  if (requestedIds.length === 0) return [];

  // Apply only active templates in workspace display order, regardless of the
  // order supplied by the automation config, so repeated actions are predictable.
  const templates = await tx
    .select()
    .from(checklistTemplates)
    .where(and(eq(checklistTemplates.workspaceId, workspaceId), isNull(checklistTemplates.archivedAt), inArray(checklistTemplates.id, requestedIds)))
    .orderBy(asc(checklistTemplates.position));
  if (templates.length === 0) return [];

  const templateIds = templates.map((template) => template.id);

  // Skip templates already applied to this card.
  const applied = await tx
    .select({ templateId: cardChecklistTemplateApplications.templateId })
    .from(cardChecklistTemplateApplications)
    .where(
      and(
        eq(cardChecklistTemplateApplications.cardId, cardId),
        inArray(cardChecklistTemplateApplications.templateId, templateIds),
      ),
    );
  const appliedIds = new Set(applied.map((row) => row.templateId));
  const pending = templates.filter((template) => !appliedIds.has(template.id));
  if (pending.length === 0) return [];

  // Load items for the pending templates in one query.
  const itemRows = await tx
    .select()
    .from(checklistTemplateItems)
    .where(inArray(checklistTemplateItems.templateId, pending.map((t) => t.id)))
    .orderBy(asc(checklistTemplateItems.position));
  const itemsByTemplate = new Map<string, typeof itemRows>();
  for (const item of itemRows) {
    const list = itemsByTemplate.get(item.templateId);
    if (list) list.push(item);
    else itemsByTemplate.set(item.templateId, [item]);
  }

  // Continue numbering after the card's existing checklists.
  const [last] = await tx
    .select({ position: cardChecklists.position })
    .from(cardChecklists)
    .where(eq(cardChecklists.cardId, cardId))
    .orderBy(desc(cardChecklists.position))
    .limit(1);
  let lastPosition = last?.position ?? null;

  const results: AppliedTemplateChecklist[] = [];
  for (const template of pending) {
    const position = between(lastPosition, null).position;
    lastPosition = position;

    const [checklist] = await tx
      .insert(cardChecklists)
      .values({ cardId, title: template.title, position })
      .returning();

    const templateItems = itemsByTemplate.get(template.id) ?? [];
    let insertedItems: (typeof cardChecklistItems.$inferSelect)[] = [];
    if (templateItems.length > 0) {
      insertedItems = await tx
        .insert(cardChecklistItems)
        .values(templateItems.map((item) => ({ checklistId: checklist!.id, text: item.text, position: item.position })))
        .returning();
    }

    await tx
      .insert(cardChecklistTemplateApplications)
      .values({ cardId, templateId: template.id })
      .onConflictDoNothing();

    const activity = await recordActivity(tx, {
      boardId,
      workspaceId,
      actorId,
      ...(!actorId && { actorKind: "system" as const }),
      entityType: "card",
      entityId: cardId,
      action: "checklist:created",
      payload: {
        checklistId: checklist!.id,
        title: checklist!.title,
        fromTemplateId: template.id,
        ...(automationActionId && { automationActionId }),
      },
    });

    results.push({ templateId: template.id, checklist: { ...checklist!, items: insertedItems }, activity });
  }

  return results;
}
