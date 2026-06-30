import { sql } from "drizzle-orm";
import { boolean, date, integer, json, numeric, pgView, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { CardCustomFieldValue } from "./card-custom-field-value.js";

export const cardSummaryView = pgView("card_summary_view", {
  id: uuid("id").notNull(),
  listId: uuid("list_id").notNull(),
  boardId: uuid("board_id").notNull(),
  title: text("title").notNull(),
  position: numeric("position", { precision: 20, scale: 10 }).notNull(),
  dueDateLocalDate: date("due_date_local_date", { mode: "string" }),
  dueDateSlot: text("due_date_slot").$type<"anyTime" | "morning" | "afternoon" | "endOfWorkDay" | null>(),
  dueDateTimezone: text("due_date_timezone"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  coverAttachmentId: uuid("cover_attachment_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  hasDescription: boolean("has_description").notNull(),
  commentCount: integer("comment_count").notNull(),
  attachmentCount: integer("attachment_count").notNull(),
  checklistDoneCount: integer("checklist_done_count").notNull(),
  checklistTotalCount: integer("checklist_total_count").notNull(),
  labelIds: uuid("label_ids").array().notNull(),
  assigneeIds: uuid("assignee_ids").array().notNull(),
  customFieldValues: json("custom_field_values").$type<CardCustomFieldValue[]>().notNull(),
  coverFileKey: text("cover_file_key"),
  coverUrl: text("cover_url"),
  coverImageFileKey: text("cover_image_file_key"),
  coverImageUrl: text("cover_image_url"),
}).as(sql`
  select
    c.id,
    c.list_id,
    c.board_id,
    c.title,
    c.position,
    c.due_date_local_date,
    c.due_date_slot,
    c.due_date_timezone,
    c.completed_at,
    c.archived_at,
    c.cover_attachment_id,
    c.created_at,
    c.updated_at,
    c.description is not null as has_description,
    coalesce(comment_counts.comment_count, 0)::integer as comment_count,
    coalesce(attachment_counts.attachment_count, 0)::integer as attachment_count,
    coalesce(checklist_counts.done_count, 0)::integer as checklist_done_count,
    coalesce(checklist_counts.total_count, 0)::integer as checklist_total_count,
    coalesce(label_ids.label_ids, '{}'::uuid[]) as label_ids,
    coalesce(assignee_ids.assignee_ids, '{}'::uuid[]) as assignee_ids,
    coalesce(custom_field_values.custom_field_values, '[]'::json) as custom_field_values,
    cover.file_key as cover_file_key,
    cover.url as cover_url,
    cover.cover_image_file_key,
    cover.cover_image_url
  from card c
  left join card_attachment cover on cover.id = c.cover_attachment_id
  left join lateral (
    select count(*)::integer as comment_count
    from comment cm
    where cm.card_id = c.id
  ) comment_counts on true
  left join lateral (
    select count(*)::integer as attachment_count
    from card_attachment ca
    where ca.card_id = c.id
  ) attachment_counts on true
  left join lateral (
    select
      count(*)::integer as total_count,
      count(*) filter (where ci.completed_at is not null)::integer as done_count
    from card_checklist cl
    inner join card_checklist_item ci on ci.checklist_id = cl.id
    where cl.card_id = c.id
  ) checklist_counts on true
  left join lateral (
    select array_agg(cla.label_id order by cla.assigned_at, cla.label_id) as label_ids
    from card_label_assignment cla
    where cla.card_id = c.id
  ) label_ids on true
  left join lateral (
    select array_agg(ca.user_id order by ca.assigned_at, ca.user_id) as assignee_ids
    from card_assignee ca
    where ca.card_id = c.id
  ) assignee_ids on true
  left join lateral (
    select json_agg(
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
    where cfv.card_id = c.id
  ) custom_field_values on true
`);
