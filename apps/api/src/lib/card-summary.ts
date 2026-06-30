import type { WireCardSummary } from "@kanera/shared/events";
import type { cardSummaryView } from "@kanera/shared/schema";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db.js";
import { signedAttachmentMediaUrl } from "./attachment-media.js";

type CardSummaryRow = typeof cardSummaryView.$inferSelect;

function uuidValueList(ids: string[]): SQL {
  return sql.join(ids.map((id) => sql`${id}`), sql`, `);
}

function completedVisibilityPredicate(options: {
  includeCompleted: boolean;
  includeArchived: boolean;
  completedCardsActiveDays: number;
  completedFrom?: Date | null;
  completedTo?: Date | null;
}): SQL {
  if (options.completedFrom || options.completedTo) {
    const rangeParts: SQL[] = [sql`c.completed_at is not null`];
    if (options.completedFrom) rangeParts.push(sql`c.completed_at >= ${options.completedFrom}`);
    if (options.completedTo) rangeParts.push(sql`c.completed_at <= ${options.completedTo}`);
    return sql`(c.completed_at is null or (${sql.join(rangeParts, sql` and `)}))`;
  }
  // The archived view is a separate axis from completion age: archived cards live until the
  // archived-card retention sweep (keyed on archived_at, not completed_at), and a card is
  // usually completed well before it is archived. So the archived view must surface every
  // archived card regardless of how long ago it was completed — the completed-age cutoff only
  // applies to the active (non-archived) view.
  if (options.includeCompleted || options.includeArchived) return sql`true`;
  const completedCutoff = new Date(Date.now() - options.completedCardsActiveDays * 24 * 60 * 60 * 1000);
  return sql`(c.completed_at is null or c.completed_at >= ${completedCutoff})`;
}

async function loadCardSummariesFromFilteredCards(whereClause: SQL): Promise<CardSummaryRow[]> {
  const result = await db.execute<CardSummaryRow>(sql`
    with filtered_cards as materialized (
      select c.*
      from card c
      where ${whereClause}
    ),
    comment_counts as (
      select cm.card_id, count(*)::integer as comment_count
      from comment cm
      inner join filtered_cards fc on fc.id = cm.card_id
      group by cm.card_id
    ),
    attachment_counts as (
      select ca.card_id, count(*)::integer as attachment_count
      from card_attachment ca
      inner join filtered_cards fc on fc.id = ca.card_id
      group by ca.card_id
    ),
    checklist_counts as (
      select
        cl.card_id,
        count(*)::integer as total_count,
        count(*) filter (where ci.completed_at is not null)::integer as done_count
      from card_checklist cl
      inner join filtered_cards fc on fc.id = cl.card_id
      inner join card_checklist_item ci on ci.checklist_id = cl.id
      group by cl.card_id
    ),
    label_ids as (
      select cla.card_id, array_agg(cla.label_id order by cla.assigned_at, cla.label_id) as label_ids
      from card_label_assignment cla
      inner join filtered_cards fc on fc.id = cla.card_id
      group by cla.card_id
    ),
    assignee_ids as (
      select ca.card_id, array_agg(ca.user_id order by ca.assigned_at, ca.user_id) as assignee_ids
      from card_assignee ca
      inner join filtered_cards fc on fc.id = ca.card_id
      group by ca.card_id
    ),
    custom_field_values as (
      select
        cfv.card_id,
        json_agg(
          json_build_object(
            'cardId', cfv.card_id,
            'fieldId', cfv.field_id,
            'valueText', cfv.value_text,
            'valueNumber', cfv.value_number::text,
            'valueCheckbox', cfv.value_checkbox,
            'valueDate', cfv.value_date,
            'valueUrl', cfv.value_url,
            'valueOptionIds', cfv.value_option_ids,
            'valueUserIds', cfv.value_user_ids,
            'updatedAt', cfv.updated_at
          )
          order by cfv.field_id
        ) as custom_field_values
      from card_custom_field_value cfv
      inner join filtered_cards fc on fc.id = cfv.card_id
      group by cfv.card_id
    )
    select
      fc.id,
      fc.list_id as "listId",
      fc.board_id as "boardId",
      fc.title,
      fc.position,
      fc.due_date_local_date as "dueDateLocalDate",
      fc.due_date_slot as "dueDateSlot",
      fc.due_date_timezone as "dueDateTimezone",
      fc.completed_at as "completedAt",
      fc.archived_at as "archivedAt",
      fc.cover_attachment_id as "coverAttachmentId",
      fc.created_at as "createdAt",
      fc.updated_at as "updatedAt",
      fc.description is not null as "hasDescription",
      coalesce(comment_counts.comment_count, 0)::integer as "commentCount",
      coalesce(attachment_counts.attachment_count, 0)::integer as "attachmentCount",
      coalesce(checklist_counts.done_count, 0)::integer as "checklistDoneCount",
      coalesce(checklist_counts.total_count, 0)::integer as "checklistTotalCount",
      coalesce(label_ids.label_ids, '{}'::uuid[]) as "labelIds",
      coalesce(assignee_ids.assignee_ids, '{}'::uuid[]) as "assigneeIds",
      coalesce(custom_field_values.custom_field_values, '[]'::json) as "customFieldValues",
      cover.file_key as "coverFileKey",
      cover.url as "coverUrl",
      cover.cover_image_file_key as "coverImageFileKey",
      cover.cover_image_url as "coverImageUrl"
    from filtered_cards fc
    left join card_attachment cover on cover.id = fc.cover_attachment_id
    left join comment_counts on comment_counts.card_id = fc.id
    left join attachment_counts on attachment_counts.card_id = fc.id
    left join checklist_counts on checklist_counts.card_id = fc.id
    left join label_ids on label_ids.card_id = fc.id
    left join assignee_ids on assignee_ids.card_id = fc.id
    left join custom_field_values on custom_field_values.card_id = fc.id
    order by fc.position, fc.id
  `);
  return result.rows;
}

export async function loadBoardCardSummaries(options: {
  boardId: string;
  includeCompleted: boolean;
  includeArchived: boolean;
  completedCardsActiveDays: number;
  completedFrom?: Date | null;
  completedTo?: Date | null;
}): Promise<CardSummaryRow[]> {
  return loadCardSummariesFromFilteredCards(sql`
    c.board_id = ${options.boardId}
    and ${options.includeArchived ? sql`c.archived_at is not null` : sql`c.archived_at is null`}
    and ${completedVisibilityPredicate(options)}
  `);
}

export async function loadAssignedWorkCardSummaries(options: {
  boardIds: string[];
  assignedUserIds: string[];
  includeCompleted: boolean;
  includeArchived: boolean;
  completedCardsActiveDays: number;
  completedFrom?: Date | null;
  completedTo?: Date | null;
}): Promise<CardSummaryRow[]> {
  if (options.boardIds.length === 0 || options.assignedUserIds.length === 0) return [];
  return loadCardSummariesFromFilteredCards(sql`
    c.board_id in (${uuidValueList(options.boardIds)})
    and ${options.includeArchived ? sql`c.archived_at is not null` : sql`c.archived_at is null`}
    and ${completedVisibilityPredicate(options)}
    and exists (
      select 1
      from card_assignee target_assignee
      where target_assignee.card_id = c.id
        and target_assignee.user_id in (${uuidValueList(options.assignedUserIds)})
    )
  `);
}

export function toWireCardSummary(
  row: CardSummaryRow,
  _clientId: string,
  // When provided, only inline custom-field values for these field ids. The board-open
  // payload uses this to ship just the values rendered as card badges (showOnCard fields);
  // the full set loads lazily for filters/List View. Pass null/undefined to inline all.
  customFieldIds?: ReadonlySet<string> | null,
): WireCardSummary {
  const coverImageUrl = signedAttachmentMediaUrl(row.coverImageUrl);
  const coverUrl = signedAttachmentMediaUrl(row.coverUrl);

  return {
    id: row.id,
    listId: row.listId,
    boardId: row.boardId,
    title: row.title,
    position: row.position,
    dueDateLocalDate: row.dueDateLocalDate,
    dueDateSlot: row.dueDateSlot,
    dueDateTimezone: row.dueDateTimezone,
    completedAt: row.completedAt,
    archivedAt: row.archivedAt,
    coverAttachmentId: row.coverAttachmentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasDescription: row.hasDescription,
    commentCount: row.commentCount,
    attachmentCount: row.attachmentCount,
    checklistDoneCount: row.checklistDoneCount,
    checklistTotalCount: row.checklistTotalCount,
    coverUrl: row.coverAttachmentId ? (coverImageUrl ?? coverUrl) : null,
    labelIds: row.labelIds,
    assigneeIds: row.assigneeIds,
    customFieldValues: customFieldIds
      ? row.customFieldValues.filter((value) => customFieldIds.has(value.fieldId))
      : row.customFieldValues,
  };
}
