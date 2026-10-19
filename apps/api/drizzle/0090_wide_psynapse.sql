CREATE TABLE "card_relation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_card_id" uuid NOT NULL,
	"target_card_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_relations_kind_ck" CHECK ("card_relation"."kind" in ('blocks', 'relates_to')),
	CONSTRAINT "card_relations_not_self_ck" CHECK ("card_relation"."source_card_id" <> "card_relation"."target_card_id")
);
--> statement-breakpoint
DROP VIEW "public"."card_summary_view";--> statement-breakpoint
ALTER TABLE "card_relation" ADD CONSTRAINT "card_relation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_relation" ADD CONSTRAINT "card_relation_source_card_id_card_id_fk" FOREIGN KEY ("source_card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_relation" ADD CONSTRAINT "card_relation_target_card_id_card_id_fk" FOREIGN KEY ("target_card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_relation" ADD CONSTRAINT "card_relation_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "card_relations_source_target_kind_uq" ON "card_relation" USING btree ("source_card_id","target_card_id","kind");--> statement-breakpoint
CREATE INDEX "card_relations_target_idx" ON "card_relation" USING btree ("target_card_id","kind");--> statement-breakpoint
CREATE INDEX "card_relations_workspace_id_idx" ON "card_relation" USING btree ("workspace_id");--> statement-breakpoint
CREATE VIEW "public"."card_summary_view" AS (
  select
    c.id,
    c.workspace_id,
    c.organisation_key,
    c.number,
    c.key,
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
    c.in_progress_since,
    c.in_progress_seconds,
    c.description is not null as has_description,
    coalesce(comment_counts.comment_count, 0)::integer as comment_count,
    coalesce(attachment_counts.attachment_count, 0)::integer as attachment_count,
    coalesce(checklist_counts.done_count, 0)::integer as checklist_done_count,
    coalesce(checklist_counts.total_count, 0)::integer as checklist_total_count,
    coalesce(blocker_counts.blocked_by_count, 0)::integer as blocked_by_count,
    coalesce(label_ids.label_ids, '{}'::uuid[]) as label_ids,
    coalesce(assignee_ids.assignee_ids, '{}'::uuid[]) as assignee_ids,
    coalesce(custom_field_values.custom_field_values, '[]'::json) as custom_field_values,
    cover.file_key as cover_file_key,
    cover.url as cover_url,
    cover.thumbnail_file_key as cover_thumbnail_file_key,
    cover.thumbnail_url as cover_thumbnail_url,
    cover.cover_image_file_key,
    cover.cover_image_url,
    cover.cover_image_width,
    cover.cover_image_height,
    cover.cover_image_color
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
      and cl.parent_item_id is null
  ) checklist_counts on true
  left join lateral (
    -- Open blockers only, including ones on boards the viewer cannot open: the count reveals no
    -- titles, and tiles must show "Blocked" either way. Keep in step with lib/card-relations.ts.
    select count(*)::integer as blocked_by_count
    from card_relation cr
    inner join card blocker on blocker.id = cr.source_card_id
    where cr.target_card_id = c.id
      and cr.kind = 'blocks'
      and blocker.completed_at is null
      and blocker.archived_at is null
  ) blocker_counts on true
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
);
--> statement-breakpoint
ALTER TABLE "automation" DROP CONSTRAINT "automations_trigger_type_ck";--> statement-breakpoint
ALTER TABLE "email_queue" DROP CONSTRAINT "email_queue_type_ck";--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notifications_reason_ck";--> statement-breakpoint
ALTER TABLE "push_queue" DROP CONSTRAINT "push_queue_reason_ck";--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_dependency_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_dependency_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_dependency_ntfy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_dependency_gotify" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_dependency_webhook" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD COLUMN "card_dependency_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD COLUMN "card_dependency_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD COLUMN "card_dependency_ntfy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD COLUMN "card_dependency_gotify" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD COLUMN "card_dependency_webhook" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automations_trigger_type_ck" CHECK ("automation"."trigger_type" in ('card_enters_list', 'card_leaves_list', 'due_date_arrives', 'due_date_approaching', 'card_becomes_inactive', 'card_in_progress_too_long', 'all_checklist_items_complete', 'card_assigned_to_user', 'card_marked_complete', 'card_label_set', 'custom_field_value_changed', 'card_unblocked', 'card_blocked'));--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_type_ck" CHECK ("email_queue"."type" in ('admin_invite', 'welcome', 'password_reset', 'email_verification', 'daily_digest', 'weekly_admin_recap', 'card_assigned', 'card_comment_added', 'comment_mentioned', 'reaction_added', 'card_dependency_added', 'card_unblocked', 'card_due_date_changed', 'card_overdue', 'checklist_item_overdue', 'card_reminder', 'invite_accepted', 'board_invite', 'board_access_granted', 'pro_trial_started', 'pro_trial_warning', 'downgraded_to_free', 'upgraded_to_pro', 'welcome_to_pro', 'billing_changed', 'billing_renewed', 'billing_payment_failed', 'billing_payment_recovered', 'seat_billed', 'seat_capacity_reduced', 'pro_cancellation_scheduled', 'pro_cancellation_reversed', 'pro_cancelled', 'import_completed', 'storage_warning', 'lifecycle_no_board', 'lifecycle_invite_team', 'lifecycle_early_success', 'lifecycle_inactive', 'lifecycle_active_checkin'));--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notifications_reason_ck" CHECK ("notification"."reason" in ('assigned', 'watching', 'mentioned', 'overdue', 'checklist_item_overdue', 'board_member_left', 'reminder', 'reacted', 'dependency'));--> statement-breakpoint
ALTER TABLE "push_queue" ADD CONSTRAINT "push_queue_reason_ck" CHECK ("push_queue"."reason" in ('test', 'assigned', 'mentioned', 'comment', 'dueDateChanged', 'overdue', 'watching', 'reminder', 'reacted', 'dependency'));
