-- The summary view depends on card.due_date_slot and must be rebuilt around its type conversion.
DROP VIEW "public"."card_summary_view";--> statement-breakpoint
-- This predicate's constants are typed as the old enum and cannot be reparsed as text automatically.
DROP INDEX "public"."webhook_deliveries_terminal_updated_at_idx";--> statement-breakpoint
ALTER TABLE "workspace_api_key" DROP CONSTRAINT "workspace_api_keys_kind_shape";--> statement-breakpoint

-- Enum-typed defaults depend on their PostgreSQL types, so remove them before casting the columns.
ALTER TABLE "admin_invite" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "admin_user" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "board_invitation_grant" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "board_invitation" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "board_member" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "client" ALTER COLUMN "plan" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "client" ALTER COLUMN "billing_status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "email_queue" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "invite_token" ALTER COLUMN "org_role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "invite_token" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "invite_workspace_grant" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "kanera_board_import" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "push_queue" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "trello_import" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "client_role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workspace_api_key" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workspace_api_key" ALTER COLUMN "scope" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workspace_member" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workspace" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint

ALTER TABLE "admin_invite" ALTER COLUMN "role" SET DATA TYPE text USING "role"::text;--> statement-breakpoint
ALTER TABLE "admin_user" ALTER COLUMN "role" SET DATA TYPE text USING "role"::text;--> statement-breakpoint
ALTER TABLE "automation_action" ALTER COLUMN "type" SET DATA TYPE text USING "type"::text;--> statement-breakpoint
ALTER TABLE "automation_run" ALTER COLUMN "outcome" SET DATA TYPE text USING "outcome"::text;--> statement-breakpoint
ALTER TABLE "automation" ALTER COLUMN "trigger_type" SET DATA TYPE text USING "trigger_type"::text;--> statement-breakpoint
ALTER TABLE "board_invitation_grant" ALTER COLUMN "role" SET DATA TYPE text USING "role"::text;--> statement-breakpoint
ALTER TABLE "board_invitation" ALTER COLUMN "role" SET DATA TYPE text USING "role"::text;--> statement-breakpoint
ALTER TABLE "board_member" ALTER COLUMN "role" SET DATA TYPE text USING "role"::text;--> statement-breakpoint
ALTER TABLE "card_checklist_item" ALTER COLUMN "due_date_slot" SET DATA TYPE text USING "due_date_slot"::text;--> statement-breakpoint
ALTER TABLE "card" ALTER COLUMN "due_date_slot" SET DATA TYPE text USING "due_date_slot"::text;--> statement-breakpoint
ALTER TABLE "client" ALTER COLUMN "plan" SET DATA TYPE text USING "plan"::text;--> statement-breakpoint
ALTER TABLE "client" ALTER COLUMN "billing_status" SET DATA TYPE text USING "billing_status"::text;--> statement-breakpoint
ALTER TABLE "client" ALTER COLUMN "billing_interval" SET DATA TYPE text USING "billing_interval"::text;--> statement-breakpoint
ALTER TABLE "custom_field" ALTER COLUMN "type" SET DATA TYPE text USING "type"::text;--> statement-breakpoint
-- Preserve the old compact queue codes while moving to operationally readable states.
ALTER TABLE "email_queue" ALTER COLUMN "status" SET DATA TYPE text USING (
  CASE "status"
    WHEN 0 THEN 'queued'
    WHEN 1 THEN 'success'
    WHEN 2 THEN 'error'
    WHEN 99 THEN 'immediate'
    ELSE "status"::text
  END
);--> statement-breakpoint
ALTER TABLE "email_verification_code" ALTER COLUMN "purpose" SET DATA TYPE text USING "purpose"::text;--> statement-breakpoint
ALTER TABLE "invite_token" ALTER COLUMN "org_role" SET DATA TYPE text USING "org_role"::text;--> statement-breakpoint
ALTER TABLE "invite_token" ALTER COLUMN "role" SET DATA TYPE text USING "role"::text;--> statement-breakpoint
ALTER TABLE "invite_workspace_grant" ALTER COLUMN "role" SET DATA TYPE text USING "role"::text;--> statement-breakpoint
ALTER TABLE "internal_link" ALTER COLUMN "source_type" SET DATA TYPE text USING "source_type"::text;--> statement-breakpoint
ALTER TABLE "internal_link" ALTER COLUMN "target_type" SET DATA TYPE text USING "target_type"::text;--> statement-breakpoint
ALTER TABLE "kanera_board_import" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;--> statement-breakpoint
ALTER TABLE "note" ALTER COLUMN "scope" SET DATA TYPE text USING "scope"::text;--> statement-breakpoint
ALTER TABLE "oauth_client" ALTER COLUMN "kind" SET DATA TYPE text USING "kind"::text;--> statement-breakpoint
ALTER TABLE "oauth_token" ALTER COLUMN "kind" SET DATA TYPE text USING "kind"::text;--> statement-breakpoint
ALTER TABLE "plan_action" ALTER COLUMN "kind" SET DATA TYPE text USING "kind"::text;--> statement-breakpoint
ALTER TABLE "push_queue" ALTER COLUMN "status" SET DATA TYPE text USING (
  CASE "status"
    WHEN 0 THEN 'queued'
    WHEN 1 THEN 'success'
    WHEN 2 THEN 'error'
    WHEN 99 THEN 'immediate'
    ELSE "status"::text
  END
);--> statement-breakpoint
ALTER TABLE "trello_import" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "client_role" SET DATA TYPE text USING "client_role"::text;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;--> statement-breakpoint
ALTER TABLE "workspace_api_key" ALTER COLUMN "kind" SET DATA TYPE text USING "kind"::text;--> statement-breakpoint
ALTER TABLE "workspace_api_key" ALTER COLUMN "scope" SET DATA TYPE text USING "scope"::text;--> statement-breakpoint
ALTER TABLE "workspace_member" ALTER COLUMN "role" SET DATA TYPE text USING "role"::text;--> statement-breakpoint
ALTER TABLE "workspace" ALTER COLUMN "kind" SET DATA TYPE text USING "kind"::text;--> statement-breakpoint

ALTER TABLE "admin_invite" ALTER COLUMN "role" SET DEFAULT 'staff';--> statement-breakpoint
ALTER TABLE "admin_user" ALTER COLUMN "role" SET DEFAULT 'staff';--> statement-breakpoint
ALTER TABLE "board_invitation_grant" ALTER COLUMN "role" SET DEFAULT 'editor';--> statement-breakpoint
ALTER TABLE "board_invitation" ALTER COLUMN "role" SET DEFAULT 'editor';--> statement-breakpoint
ALTER TABLE "board_member" ALTER COLUMN "role" SET DEFAULT 'editor';--> statement-breakpoint
ALTER TABLE "client" ALTER COLUMN "plan" SET DEFAULT 'free';--> statement-breakpoint
ALTER TABLE "client" ALTER COLUMN "billing_status" SET DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "email_queue" ALTER COLUMN "status" SET DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE "invite_token" ALTER COLUMN "org_role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "invite_token" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "invite_workspace_grant" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "kanera_board_import" ALTER COLUMN "status" SET DEFAULT 'ready';--> statement-breakpoint
ALTER TABLE "push_queue" ALTER COLUMN "status" SET DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE "trello_import" ALTER COLUMN "status" SET DEFAULT 'ready';--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "client_role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "webhook_delivery" ALTER COLUMN "status" SET DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE "workspace_api_key" ALTER COLUMN "kind" SET DEFAULT 'workspace';--> statement-breakpoint
ALTER TABLE "workspace_api_key" ALTER COLUMN "scope" SET DEFAULT 'read';--> statement-breakpoint
ALTER TABLE "workspace_member" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "workspace" ALTER COLUMN "kind" SET DEFAULT 'standard';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_terminal_updated_at_idx" ON "webhook_delivery" USING btree ("status","updated_at") WHERE "webhook_delivery"."status" in ('success', 'failed');--> statement-breakpoint
ALTER TABLE "activity_event" ADD CONSTRAINT "activity_events_actor_kind_ck" CHECK ("activity_event"."actor_kind" in ('user', 'apiKey', 'system', 'support'));--> statement-breakpoint
ALTER TABLE "admin_invite" ADD CONSTRAINT "admin_invites_role_ck" CHECK ("admin_invite"."role" in ('superadmin', 'staff'));--> statement-breakpoint
ALTER TABLE "admin_user" ADD CONSTRAINT "admin_users_role_ck" CHECK ("admin_user"."role" in ('superadmin', 'staff'));--> statement-breakpoint
ALTER TABLE "assigned_work_separator" ADD CONSTRAINT "assigned_work_separators_color_ck" CHECK ("assigned_work_separator"."color" in ('rose', 'pink', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'gray', 'olive', 'brown'));--> statement-breakpoint
ALTER TABLE "automation_action" ADD CONSTRAINT "automation_actions_type_ck" CHECK ("automation_action"."type" in ('add_labels', 'remove_labels', 'add_assignees', 'remove_assignees', 'apply_checklists', 'set_due_date', 'clear_due_date', 'set_completion', 'move_to_list', 'move_to_top', 'move_to_bottom', 'populate_custom_field'));--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_runs_outcome_ck" CHECK ("automation_run"."outcome" in ('effectful', 'noop', 'failed'));--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automations_trigger_type_ck" CHECK ("automation"."trigger_type" in ('card_enters_list', 'due_date_arrives', 'all_checklist_items_complete', 'card_assigned_to_user', 'card_marked_complete', 'card_label_set'));--> statement-breakpoint
ALTER TABLE "board_invitation_grant" ADD CONSTRAINT "board_invitation_grants_role_ck" CHECK ("board_invitation_grant"."role" in ('editor', 'observer'));--> statement-breakpoint
ALTER TABLE "board_invitation" ADD CONSTRAINT "board_invitations_role_ck" CHECK ("board_invitation"."role" in ('editor', 'observer'));--> statement-breakpoint
ALTER TABLE "board_member" ADD CONSTRAINT "board_members_role_ck" CHECK ("board_member"."role" in ('editor', 'observer'));--> statement-breakpoint
ALTER TABLE "board_mirror_dirty_card" ADD CONSTRAINT "board_mirror_dirty_cards_facets_ck" CHECK ("board_mirror_dirty_card"."facets" <@ array['link', 'core', 'labels', 'fields', 'comments', 'attachments', 'checklists', 'activities']::text[]);--> statement-breakpoint
ALTER TABLE "board_separator" ADD CONSTRAINT "board_separators_color_ck" CHECK ("board_separator"."color" in ('rose', 'pink', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'gray', 'olive', 'brown'));--> statement-breakpoint
ALTER TABLE "board" ADD CONSTRAINT "boards_icon_color_ck" CHECK ("board"."icon_color" in ('rose', 'pink', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'gray', 'olive', 'brown'));--> statement-breakpoint
ALTER TABLE "board" ADD CONSTRAINT "boards_background_gradient_ck" CHECK ("board"."background_gradient" in ('sunrise', 'ocean', 'forest', 'dusk', 'midnight', 'ember', 'mint', 'lavender', 'peach', 'graphite'));--> statement-breakpoint
ALTER TABLE "card_attachment" ADD CONSTRAINT "card_attachments_source_ck" CHECK ("card_attachment"."source" in ('description', 'attachment', 'comment'));--> statement-breakpoint
ALTER TABLE "card_checklist_item" ADD CONSTRAINT "card_checklist_items_due_date_slot_ck" CHECK ("card_checklist_item"."due_date_slot" in ('anyTime', 'morning', 'afternoon', 'endOfWorkDay'));--> statement-breakpoint
ALTER TABLE "card_label" ADD CONSTRAINT "card_labels_color_ck" CHECK ("card_label"."color" in ('rose', 'pink', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'gray', 'olive', 'brown'));--> statement-breakpoint
ALTER TABLE "card_mention" ADD CONSTRAINT "card_mentions_source_ck" CHECK ("card_mention"."source" in ('description', 'comment'));--> statement-breakpoint
ALTER TABLE "card" ADD CONSTRAINT "cards_due_date_slot_ck" CHECK ("card"."due_date_slot" in ('anyTime', 'morning', 'afternoon', 'endOfWorkDay'));--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "clients_plan_ck" CHECK ("client"."plan" in ('free', 'paid'));--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "clients_billing_status_ck" CHECK ("client"."billing_status" in ('none', 'trialing', 'active', 'past_due', 'canceled'));--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "clients_billing_interval_ck" CHECK ("client"."billing_interval" in ('monthly', 'annual'));--> statement-breakpoint
ALTER TABLE "comment_reaction" ADD CONSTRAINT "comment_reactions_type_ck" CHECK ("comment_reaction"."reaction_type" in ('thumbs_up'));--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comments_author_kind_ck" CHECK ("comment"."author_kind" in ('user', 'apiKey', 'system'));--> statement-breakpoint
ALTER TABLE "custom_field" ADD CONSTRAINT "custom_fields_type_ck" CHECK ("custom_field"."type" in ('text', 'number', 'checkbox', 'select', 'date', 'url', 'user'));--> statement-breakpoint
ALTER TABLE "custom_field_option" ADD CONSTRAINT "custom_field_options_color_ck" CHECK ("custom_field_option"."color" in ('rose', 'pink', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'gray', 'olive', 'brown'));--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_type_ck" CHECK ("email_queue"."type" in ('admin_invite', 'welcome', 'password_reset', 'email_verification', 'daily_digest', 'card_assigned', 'card_comment_added', 'comment_mentioned', 'card_due_date_changed', 'card_overdue', 'checklist_item_overdue', 'invite_accepted', 'board_invite', 'board_access_granted', 'pro_trial_started', 'pro_trial_warning', 'downgraded_to_free', 'upgraded_to_pro', 'welcome_to_pro', 'billing_changed', 'seat_billed', 'pro_cancelled'));--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_status_ck" CHECK ("email_queue"."status" in ('queued', 'success', 'error', 'immediate'));--> statement-breakpoint
ALTER TABLE "email_verification_code" ADD CONSTRAINT "email_verification_codes_purpose_ck" CHECK ("email_verification_code"."purpose" in ('signup', 'email_change'));--> statement-breakpoint
ALTER TABLE "event_outbox" ADD CONSTRAINT "event_outbox_scope_ck" CHECK ("event_outbox"."scope" in ('workspace', 'board'));--> statement-breakpoint
ALTER TABLE "invite_token" ADD CONSTRAINT "invite_tokens_org_role_ck" CHECK ("invite_token"."org_role" in ('owner', 'admin', 'member'));--> statement-breakpoint
ALTER TABLE "invite_token" ADD CONSTRAINT "invite_tokens_role_ck" CHECK ("invite_token"."role" in ('admin', 'member'));--> statement-breakpoint
ALTER TABLE "invite_workspace_grant" ADD CONSTRAINT "invite_workspace_grants_role_ck" CHECK ("invite_workspace_grant"."role" in ('admin', 'member'));--> statement-breakpoint
ALTER TABLE "internal_link" ADD CONSTRAINT "internal_links_source_type_ck" CHECK ("internal_link"."source_type" in ('card', 'note'));--> statement-breakpoint
ALTER TABLE "internal_link" ADD CONSTRAINT "internal_links_target_type_ck" CHECK ("internal_link"."target_type" in ('card', 'board', 'note'));--> statement-breakpoint
ALTER TABLE "kanera_board_import" ADD CONSTRAINT "kanera_board_imports_status_ck" CHECK ("kanera_board_import"."status" in ('ready', 'importing', 'completed', 'failed'));--> statement-breakpoint
ALTER TABLE "list" ADD CONSTRAINT "lists_color_ck" CHECK ("list"."color" in ('rose', 'pink', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'gray', 'olive', 'brown'));--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "notes_scope_ck" CHECK ("note"."scope" in ('personal', 'team'));--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "notes_color_ck" CHECK ("note"."color" in ('rose', 'pink', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'gray', 'olive', 'brown'));--> statement-breakpoint
ALTER TABLE "note_attachment" ADD CONSTRAINT "note_attachments_source_ck" CHECK ("note_attachment"."source" in ('description', 'attachment'));--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notifications_reason_ck" CHECK ("notification"."reason" in ('assigned', 'watching', 'mentioned', 'overdue', 'checklist_item_overdue'));--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_clients_kind_ck" CHECK ("oauth_client"."kind" in ('public', 'service'));--> statement-breakpoint
ALTER TABLE "oauth_token" ADD CONSTRAINT "oauth_tokens_kind_ck" CHECK ("oauth_token"."kind" in ('access', 'refresh'));--> statement-breakpoint
ALTER TABLE "plan_action" ADD CONSTRAINT "plan_actions_kind_ck" CHECK ("plan_action"."kind" in ('automation_disabled', 'webhook_disabled', 'api_key_revoked', 'board_archived', 'workspace_archived', 'user_suspended', 'guest_member_removed', 'guest_invitation_revoked', 'guest_seat_removed'));--> statement-breakpoint
ALTER TABLE "push_queue" ADD CONSTRAINT "push_queue_reason_ck" CHECK ("push_queue"."reason" in ('test', 'assigned', 'mentioned', 'comment', 'dueDateChanged', 'overdue', 'watching'));--> statement-breakpoint
ALTER TABLE "push_queue" ADD CONSTRAINT "push_queue_status_ck" CHECK ("push_queue"."status" in ('queued', 'success', 'error', 'immediate'));--> statement-breakpoint
ALTER TABLE "trello_import" ADD CONSTRAINT "trello_imports_status_ck" CHECK ("trello_import"."status" in ('analyzed', 'ready', 'importing', 'completed', 'failed'));--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "users_client_role_ck" CHECK ("user"."client_role" in ('owner', 'admin', 'member'));--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_deliveries_status_ck" CHECK ("webhook_delivery"."status" in ('queued', 'delivering', 'success', 'failed'));--> statement-breakpoint
ALTER TABLE "workspace_api_key" ADD CONSTRAINT "workspace_api_keys_kind_ck" CHECK ("workspace_api_key"."kind" in ('workspace', 'personal'));--> statement-breakpoint
ALTER TABLE "workspace_api_key" ADD CONSTRAINT "workspace_api_keys_scope_ck" CHECK ("workspace_api_key"."scope" in ('read', 'write', 'admin'));--> statement-breakpoint
ALTER TABLE "workspace_api_key" ADD CONSTRAINT "workspace_api_keys_kind_shape" CHECK (("workspace_api_key"."kind" = 'workspace' and "workspace_api_key"."workspace_id" is not null and "workspace_api_key"."name" is not null)
        or ("workspace_api_key"."kind" = 'personal' and "workspace_api_key"."workspace_id" is null));--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_members_role_ck" CHECK ("workspace_member"."role" in ('admin', 'member'));--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspaces_kind_ck" CHECK ("workspace"."kind" in ('standard', 'board'));--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspaces_accent_color_ck" CHECK ("workspace"."accent_color" in ('rose', 'pink', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'gray', 'olive', 'brown'));--> statement-breakpoint
DROP TYPE "public"."admin_role";--> statement-breakpoint
DROP TYPE "public"."automation_action_type";--> statement-breakpoint
DROP TYPE "public"."automation_run_outcome";--> statement-breakpoint
DROP TYPE "public"."automation_trigger_type";--> statement-breakpoint
DROP TYPE "public"."card_due_date_slot";--> statement-breakpoint
DROP TYPE "public"."client_role";--> statement-breakpoint
DROP TYPE "public"."client_billing_interval";--> statement-breakpoint
DROP TYPE "public"."client_billing_status";--> statement-breakpoint
DROP TYPE "public"."client_plan";--> statement-breakpoint
DROP TYPE "public"."custom_field_type";--> statement-breakpoint
DROP TYPE "public"."email_verification_purpose";--> statement-breakpoint
DROP TYPE "public"."internal_link_source_type";--> statement-breakpoint
DROP TYPE "public"."internal_link_target_type";--> statement-breakpoint
DROP TYPE "public"."kanera_board_import_status";--> statement-breakpoint
DROP TYPE "public"."board_role";--> statement-breakpoint
DROP TYPE "public"."workspace_role";--> statement-breakpoint
DROP TYPE "public"."note_scope";--> statement-breakpoint
DROP TYPE "public"."oauth_client_kind";--> statement-breakpoint
DROP TYPE "public"."oauth_token_kind";--> statement-breakpoint
DROP TYPE "public"."plan_action_kind";--> statement-breakpoint
DROP TYPE "public"."trello_import_status";--> statement-breakpoint
DROP TYPE "public"."webhook_delivery_status";--> statement-breakpoint
DROP TYPE "public"."workspace_api_key_kind";--> statement-breakpoint
DROP TYPE "public"."workspace_api_key_scope";--> statement-breakpoint
DROP TYPE "public"."workspace_kind";--> statement-breakpoint

CREATE VIEW "public"."card_summary_view" AS (
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
