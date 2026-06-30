CREATE EXTENSION IF NOT EXISTS "citext";--> statement-breakpoint
CREATE TYPE "public"."automation_action_type" AS ENUM('add_labels', 'remove_labels', 'add_assignees', 'remove_assignees', 'apply_checklists', 'set_due_date', 'clear_due_date', 'set_completion', 'move_to_list', 'move_to_top', 'move_to_bottom');--> statement-breakpoint
CREATE TYPE "public"."automation_trigger_type" AS ENUM('card_enters_list', 'due_date_arrives', 'all_checklist_items_complete', 'card_assigned_to_user');--> statement-breakpoint
CREATE TYPE "public"."board_visibility" AS ENUM('private', 'workspace');--> statement-breakpoint
CREATE TYPE "public"."card_due_date_slot" AS ENUM('anyTime', 'morning', 'afternoon', 'endOfWorkDay');--> statement-breakpoint
CREATE TYPE "public"."client_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."client_billing_interval" AS ENUM('monthly', 'annual');--> statement-breakpoint
CREATE TYPE "public"."client_billing_status" AS ENUM('none', 'trialing', 'active', 'past_due', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."client_plan" AS ENUM('free', 'paid');--> statement-breakpoint
CREATE TYPE "public"."custom_field_type" AS ENUM('text', 'number', 'checkbox', 'select', 'date', 'url', 'user');--> statement-breakpoint
CREATE TYPE "public"."email_verification_purpose" AS ENUM('signup', 'email_change');--> statement-breakpoint
CREATE TYPE "public"."internal_link_source_type" AS ENUM('card', 'note');--> statement-breakpoint
CREATE TYPE "public"."internal_link_target_type" AS ENUM('card', 'board', 'note');--> statement-breakpoint
CREATE TYPE "public"."kanera_board_import_status" AS ENUM('ready', 'importing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member', 'observer');--> statement-breakpoint
CREATE TYPE "public"."note_scope" AS ENUM('personal', 'team');--> statement-breakpoint
CREATE TYPE "public"."plan_action_kind" AS ENUM('automation_disabled', 'webhook_disabled', 'api_key_revoked', 'board_archived', 'workspace_archived', 'user_suspended', 'guest_member_removed', 'guest_invitation_revoked', 'guest_seat_removed');--> statement-breakpoint
CREATE TYPE "public"."trello_import_status" AS ENUM('analyzed', 'ready', 'importing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('queued', 'delivering', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."workspace_api_key_scope" AS ENUM('read', 'write', 'admin');--> statement-breakpoint
CREATE TABLE "activity_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"board_id" uuid,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_kind" text DEFAULT 'user' NOT NULL,
	"api_key_id" uuid,
	"api_key_name" text,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"feed_visible" boolean DEFAULT true NOT NULL,
	"coalesce_key" text,
	"coalesced_count" integer DEFAULT 1 NOT NULL,
	"coalesced_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_action" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"automation_id" uuid NOT NULL,
	"type" "automation_action_type" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" numeric(20, 10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_due_date_run" (
	"automation_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"due_date_local_date" text NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_due_date_run_automation_id_card_id_pk" PRIMARY KEY("automation_id","card_id")
);
--> statement-breakpoint
CREATE TABLE "automation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"position" numeric(20, 10) NOT NULL,
	"trigger_type" "automation_trigger_type" NOT NULL,
	"trigger_list_id" uuid,
	"trigger_user_ids" uuid[],
	"apply_on_create" boolean DEFAULT true NOT NULL,
	"apply_on_move" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_invitation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"board_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_id" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_invitation_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "board_group" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"position" numeric(20, 10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_member" (
	"board_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_member_board_id_user_id_pk" PRIMARY KEY("board_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "board_watcher" (
	"board_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_watcher_board_id_user_id_pk" PRIMARY KEY("board_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "board" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"group_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"icon_color" text,
	"background_gradient" text,
	"position" numeric(20, 10) NOT NULL,
	"visibility" "board_visibility" DEFAULT 'workspace' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_assignee" (
	"card_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_assignee_card_id_user_id_pk" PRIMARY KEY("card_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "card_attachment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"card_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"uploaded_by_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"file_key" text NOT NULL,
	"url" text NOT NULL,
	"thumbnail_url" text,
	"thumbnail_file_key" text,
	"cover_image_url" text,
	"cover_image_file_key" text,
	"source" text DEFAULT 'attachment' NOT NULL,
	"comment_id" uuid,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(file_name, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_checklist_item" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"checklist_id" uuid NOT NULL,
	"text" text NOT NULL,
	"position" numeric(20, 10) NOT NULL,
	"assignee_id" uuid,
	"due_date_local_date" date,
	"due_date_slot" "card_due_date_slot",
	"due_date_timezone" text,
	"completed_at" timestamp with time zone,
	"completed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_checklist" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"card_id" uuid NOT NULL,
	"title" text NOT NULL,
	"position" numeric(20, 10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_checklist_template_application" (
	"card_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_checklist_template_application_card_id_template_id_pk" PRIMARY KEY("card_id","template_id")
);
--> statement-breakpoint
CREATE TABLE "checklist_template_item" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"template_id" uuid NOT NULL,
	"text" text NOT NULL,
	"position" numeric(20, 10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_template" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"position" numeric(20, 10) NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_custom_field_value" (
	"card_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"value_text" text,
	"value_number" numeric,
	"value_checkbox" boolean,
	"value_date" text,
	"value_url" text,
	"value_option_ids" uuid[],
	"value_user_ids" uuid[],
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_custom_field_value_card_id_field_id_pk" PRIMARY KEY("card_id","field_id")
);
--> statement-breakpoint
CREATE TABLE "card_label_assignment" (
	"card_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_label_assignment_card_id_label_id_pk" PRIMARY KEY("card_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "card_label" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"position" numeric(20, 10) NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_mention" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"card_id" uuid NOT NULL,
	"comment_id" uuid,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_watcher" (
	"card_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_watcher_card_id_user_id_pk" PRIMARY KEY("card_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "card" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"list_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"position" numeric(20, 10) NOT NULL,
	"due_date_local_date" date,
	"due_date_slot" "card_due_date_slot",
	"due_date_timezone" text,
	"completed_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_by_id" uuid NOT NULL,
	"cover_attachment_id" uuid,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_guest_seat" (
	"client_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_guest_seat_client_id_user_id_pk" PRIMARY KEY("client_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "client" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"logo_url" text,
	"push_enabled" boolean DEFAULT false NOT NULL,
	"storage_config" jsonb,
	"smtp_config" jsonb,
	"plan" "client_plan" DEFAULT 'free' NOT NULL,
	"billing_status" "client_billing_status" DEFAULT 'none' NOT NULL,
	"billing_interval" "client_billing_interval",
	"storage_quota_bytes" bigint,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_subscription_item_id" text,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comment_reaction" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"comment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reaction_type" text DEFAULT 'thumbs_up' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"card_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"author_kind" text DEFAULT 'user' NOT NULL,
	"api_key_id" uuid,
	"api_key_name" text,
	"body" text NOT NULL,
	"edited_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"icon" text DEFAULT 'forms' NOT NULL,
	"type" "custom_field_type" NOT NULL,
	"allow_multiple" boolean DEFAULT false NOT NULL,
	"position" numeric(20, 10) NOT NULL,
	"show_on_card" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_option" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"field_id" uuid NOT NULL,
	"label" text NOT NULL,
	"color" text,
	"position" numeric(20, 10) NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_queue" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_verification_code" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" "citext" NOT NULL,
	"code_hash" text NOT NULL,
	"purpose" "email_verification_purpose" NOT NULL,
	"user_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_outbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"scope" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"board_id" uuid,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"realtime_dispatched" boolean DEFAULT false NOT NULL,
	"webhooks_enqueued" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processing_lease_expires_at" timestamp with time zone,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_link" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_type" text NOT NULL,
	"external_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_app" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"encrypted_app_id" text NOT NULL,
	"app_slug" text NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"encrypted_webhook_secret" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_app_installation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"installation_id" text NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"repository_selection" text NOT NULL,
	"repositories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_token" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"workspace_id" uuid,
	"token_hash" text NOT NULL,
	"org_role" "client_role" DEFAULT 'member' NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"email" text,
	"expires_at" timestamp with time zone,
	"created_by_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "invite_workspace_grant" (
	"invite_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	CONSTRAINT "invite_workspace_grant_invite_id_workspace_id_pk" PRIMARY KEY("invite_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "internal_link" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_type" "internal_link_source_type" NOT NULL,
	"source_id" uuid NOT NULL,
	"target_type" "internal_link_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kanera_board_import" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"status" "kanera_board_import_status" DEFAULT 'ready' NOT NULL,
	"source_file_key" text NOT NULL,
	"source_file_name" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"mappings" jsonb,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "list" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"color" text,
	"position" numeric(20, 10) NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"board_id" uuid,
	"parent_note_id" uuid,
	"scope" "note_scope" NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"icon" text,
	"position" numeric(20, 10) NOT NULL,
	"editing_user_id" uuid,
	"editing_expires_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(content, '')), 'B')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_attachment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"note_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"uploaded_by_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"file_key" text NOT NULL,
	"url" text NOT NULL,
	"source" text DEFAULT 'attachment' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"activity_id" uuid,
	"card_id" uuid,
	"checklist_item_id" uuid,
	"list_id" uuid,
	"board_id" uuid,
	"workspace_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"push_enabled" boolean DEFAULT false NOT NULL,
	"card_assigned_email" boolean DEFAULT true NOT NULL,
	"card_assigned_push" boolean DEFAULT true NOT NULL,
	"card_comment_added_email" boolean DEFAULT true NOT NULL,
	"card_comment_added_push" boolean DEFAULT true NOT NULL,
	"comment_mentioned_email" boolean DEFAULT true NOT NULL,
	"comment_mentioned_push" boolean DEFAULT true NOT NULL,
	"card_due_date_changed_email" boolean DEFAULT true NOT NULL,
	"card_due_date_changed_push" boolean DEFAULT true NOT NULL,
	"card_overdue_email" boolean DEFAULT true NOT NULL,
	"card_overdue_push" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_token" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "plan_action" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" "plan_action_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_queue" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscription" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"key_p256dh" text NOT NULL,
	"key_auth" text NOT NULL,
	"expiration_time" timestamp with time zone,
	"content_encoding" text,
	"device_label" text,
	"user_agent" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"last_error" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_token" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "system_config" (
	"id" text PRIMARY KEY NOT NULL,
	"vapid_subject" text,
	"vapid_public_key" text,
	"vapid_private_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_event" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trello_import" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"status" "trello_import_status" DEFAULT 'ready' NOT NULL,
	"source_file_key" text NOT NULL,
	"source_file_name" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"mappings" jsonb,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"client_role" "client_role" DEFAULT 'member' NOT NULL,
	"email" "citext" NOT NULL,
	"email_verified_at" timestamp with time zone,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"outbox_event_id" uuid,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"response_status" integer,
	"response_body" text,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoint" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"event_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_api_key" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scope" "workspace_api_key_scope" DEFAULT 'read' NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_member" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_member_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"accent_color" text,
	"completed_cards_active_days" integer DEFAULT 20 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_event" ADD CONSTRAINT "activity_event_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_event" ADD CONSTRAINT "activity_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_event" ADD CONSTRAINT "activity_event_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_event" ADD CONSTRAINT "activity_event_api_key_id_workspace_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."workspace_api_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_action" ADD CONSTRAINT "automation_action_automation_id_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_due_date_run" ADD CONSTRAINT "automation_due_date_run_automation_id_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_due_date_run" ADD CONSTRAINT "automation_due_date_run_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automation_trigger_list_id_list_id_fk" FOREIGN KEY ("trigger_list_id") REFERENCES "public"."list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_invitation" ADD CONSTRAINT "board_invitation_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_invitation" ADD CONSTRAINT "board_invitation_invited_by_id_user_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_invitation" ADD CONSTRAINT "board_invitation_accepted_by_user_id_user_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_group" ADD CONSTRAINT "board_group_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_member" ADD CONSTRAINT "board_member_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_member" ADD CONSTRAINT "board_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_watcher" ADD CONSTRAINT "board_watcher_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_watcher" ADD CONSTRAINT "board_watcher_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board" ADD CONSTRAINT "board_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board" ADD CONSTRAINT "board_group_id_board_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."board_group"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_assignee" ADD CONSTRAINT "card_assignee_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_assignee" ADD CONSTRAINT "card_assignee_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_attachment" ADD CONSTRAINT "card_attachment_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_attachment" ADD CONSTRAINT "card_attachment_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_attachment" ADD CONSTRAINT "card_attachment_uploaded_by_id_user_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_checklist_item" ADD CONSTRAINT "card_checklist_item_checklist_id_card_checklist_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."card_checklist"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_checklist_item" ADD CONSTRAINT "card_checklist_item_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_checklist_item" ADD CONSTRAINT "card_checklist_item_completed_by_id_user_id_fk" FOREIGN KEY ("completed_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_checklist" ADD CONSTRAINT "card_checklist_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_checklist_template_application" ADD CONSTRAINT "card_checklist_template_application_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_checklist_template_application" ADD CONSTRAINT "card_checklist_template_application_template_id_checklist_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."checklist_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_template_item" ADD CONSTRAINT "checklist_template_item_template_id_checklist_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."checklist_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_template" ADD CONSTRAINT "checklist_template_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_custom_field_value" ADD CONSTRAINT "card_custom_field_value_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_custom_field_value" ADD CONSTRAINT "card_custom_field_value_field_id_custom_field_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."custom_field"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_label_assignment" ADD CONSTRAINT "card_label_assignment_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_label_assignment" ADD CONSTRAINT "card_label_assignment_label_id_card_label_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."card_label"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_label" ADD CONSTRAINT "card_label_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_mention" ADD CONSTRAINT "card_mention_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_mention" ADD CONSTRAINT "card_mention_comment_id_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_mention" ADD CONSTRAINT "card_mention_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_watcher" ADD CONSTRAINT "card_watcher_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_watcher" ADD CONSTRAINT "card_watcher_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card" ADD CONSTRAINT "card_list_id_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card" ADD CONSTRAINT "card_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card" ADD CONSTRAINT "card_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_guest_seat" ADD CONSTRAINT "client_guest_seat_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_guest_seat" ADD CONSTRAINT "client_guest_seat_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_guest_seat" ADD CONSTRAINT "client_guest_seat_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_reaction" ADD CONSTRAINT "comment_reaction_comment_id_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_reaction" ADD CONSTRAINT "comment_reaction_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_api_key_id_workspace_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."workspace_api_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field" ADD CONSTRAINT "custom_field_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_option" ADD CONSTRAINT "custom_field_option_field_id_custom_field_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."custom_field"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verification_code" ADD CONSTRAINT "email_verification_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD CONSTRAINT "event_outbox_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD CONSTRAINT "event_outbox_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_link" ADD CONSTRAINT "external_link_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_app_installation" ADD CONSTRAINT "github_app_installation_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_token" ADD CONSTRAINT "invite_token_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_token" ADD CONSTRAINT "invite_token_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_token" ADD CONSTRAINT "invite_token_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_workspace_grant" ADD CONSTRAINT "invite_workspace_grant_invite_id_invite_token_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invite_token"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_workspace_grant" ADD CONSTRAINT "invite_workspace_grant_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_link" ADD CONSTRAINT "internal_link_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kanera_board_import" ADD CONSTRAINT "kanera_board_import_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kanera_board_import" ADD CONSTRAINT "kanera_board_import_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kanera_board_import" ADD CONSTRAINT "kanera_board_import_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list" ADD CONSTRAINT "list_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_editing_user_id_user_id_fk" FOREIGN KEY ("editing_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_parent_note_id_fk" FOREIGN KEY ("parent_note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_attachment" ADD CONSTRAINT "note_attachment_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_attachment" ADD CONSTRAINT "note_attachment_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_attachment" ADD CONSTRAINT "note_attachment_uploaded_by_id_user_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_activity_id_activity_event_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_checklist_item_id_card_checklist_item_id_fk" FOREIGN KEY ("checklist_item_id") REFERENCES "public"."card_checklist_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_list_id_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."list"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_action" ADD CONSTRAINT "plan_action_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_queue" ADD CONSTRAINT "push_queue_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_queue" ADD CONSTRAINT "push_queue_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trello_import" ADD CONSTRAINT "trello_import_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trello_import" ADD CONSTRAINT "trello_import_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trello_import" ADD CONSTRAINT "trello_import_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpoint_id_webhook_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_outbox_event_id_event_outbox_id_fk" FOREIGN KEY ("outbox_event_id") REFERENCES "public"."event_outbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_api_key" ADD CONSTRAINT "workspace_api_key_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_api_key" ADD CONSTRAINT "workspace_api_key_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_board_id_created_at_idx" ON "activity_event" USING btree ("board_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_events_workspace_id_created_at_idx" ON "activity_event" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_events_coalesce_probe_idx" ON "activity_event" USING btree ("workspace_id","actor_id","actor_kind","api_key_id","entity_type","entity_id","action","coalesce_key","updated_at");--> statement-breakpoint
CREATE INDEX "automation_actions_automation_position_idx" ON "automation_action" USING btree ("automation_id","position");--> statement-breakpoint
CREATE INDEX "automations_workspace_id_position_idx" ON "automation" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE INDEX "automations_active_workspace_position_idx" ON "automation" USING btree ("workspace_id","position") WHERE "automation"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "board_invitations_board_id_idx" ON "board_invitation" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "board_invitations_token_hash_idx" ON "board_invitation" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "board_groups_workspace_id_position_idx" ON "board_group" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE INDEX "board_members_user_id_idx" ON "board_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "board_watchers_user_id_idx" ON "board_watcher" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "boards_workspace_id_position_idx" ON "board" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE INDEX "boards_group_id_idx" ON "board" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "boards_active_workspace_position_idx" ON "board" USING btree ("workspace_id","position") WHERE "board"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "card_assignees_user_id_idx" ON "card_assignee" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "card_attachments_search_vector_idx" ON "card_attachment" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "card_attachments_client_id_idx" ON "card_attachment" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "card_attachments_card_id_created_at_idx" ON "card_attachment" USING btree ("card_id","created_at");--> statement-breakpoint
CREATE INDEX "card_attachments_uploaded_by_id_idx" ON "card_attachment" USING btree ("uploaded_by_id");--> statement-breakpoint
CREATE INDEX "card_attachments_comment_id_idx" ON "card_attachment" USING btree ("comment_id") WHERE "card_attachment"."comment_id" is not null;--> statement-breakpoint
CREATE INDEX "card_checklist_items_checklist_position_idx" ON "card_checklist_item" USING btree ("checklist_id","position");--> statement-breakpoint
CREATE INDEX "card_checklist_items_assignee_id_idx" ON "card_checklist_item" USING btree ("assignee_id") WHERE "card_checklist_item"."assignee_id" is not null;--> statement-breakpoint
CREATE INDEX "card_checklists_card_position_idx" ON "card_checklist" USING btree ("card_id","position");--> statement-breakpoint
CREATE INDEX "checklist_template_items_template_position_idx" ON "checklist_template_item" USING btree ("template_id","position");--> statement-breakpoint
CREATE INDEX "checklist_templates_workspace_id_position_idx" ON "checklist_template" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE INDEX "checklist_templates_active_workspace_position_idx" ON "checklist_template" USING btree ("workspace_id","position") WHERE "checklist_template"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "card_custom_field_values_field_id_idx" ON "card_custom_field_value" USING btree ("field_id");--> statement-breakpoint
CREATE INDEX "card_label_assignments_label_id_idx" ON "card_label_assignment" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "card_labels_workspace_id_position_idx" ON "card_label" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE INDEX "card_labels_active_workspace_position_idx" ON "card_label" USING btree ("workspace_id","position") WHERE "card_label"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "card_mentions_card_id_idx" ON "card_mention" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "card_mentions_user_id_idx" ON "card_mention" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "card_mentions_description_uniq" ON "card_mention" USING btree ("card_id","user_id","source") WHERE "card_mention"."comment_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "card_mentions_comment_uniq" ON "card_mention" USING btree ("card_id","comment_id","user_id","source") WHERE "card_mention"."comment_id" is not null;--> statement-breakpoint
CREATE INDEX "card_watchers_user_id_idx" ON "card_watcher" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cards_search_vector_idx" ON "card" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "cards_board_list_position_idx" ON "card" USING btree ("board_id","list_id","position");--> statement-breakpoint
CREATE INDEX "cards_board_id_idx" ON "card" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "cards_list_id_idx" ON "card" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "cards_active_board_list_position_idx" ON "card" USING btree ("board_id","list_id","position") WHERE "card"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "cards_active_list_position_idx" ON "card" USING btree ("list_id","position") WHERE "card"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "cards_active_board_position_idx" ON "card" USING btree ("board_id","position") WHERE "card"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "cards_active_incomplete_due_date_idx" ON "card" USING btree ("due_date_local_date","id") WHERE "card"."due_date_local_date" is not null and "card"."completed_at" is null and "card"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "cards_completed_history_idx" ON "card" USING btree ("board_id","completed_at" desc,"id") WHERE "card"."completed_at" is not null and "card"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "cards_completed_history_list_idx" ON "card" USING btree ("board_id","list_id","completed_at" desc,"id") WHERE "card"."completed_at" is not null and "card"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "client_guest_seats_user_id_idx" ON "client_guest_seat" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "client_guest_seats_created_by_id_idx" ON "client_guest_seat" USING btree ("created_by_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comment_reactions_comment_user_type_uniq" ON "comment_reaction" USING btree ("comment_id","user_id","reaction_type");--> statement-breakpoint
CREATE INDEX "comment_reactions_comment_idx" ON "comment_reaction" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "comments_card_id_created_at_idx" ON "comment" USING btree ("card_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_search_vector_idx" ON "comment" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "custom_fields_workspace_id_position_idx" ON "custom_field" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE INDEX "custom_fields_active_workspace_position_idx" ON "custom_field" USING btree ("workspace_id","position") WHERE "custom_field"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "custom_field_options_field_id_position_idx" ON "custom_field_option" USING btree ("field_id","position");--> statement-breakpoint
CREATE INDEX "custom_field_options_active_field_position_idx" ON "custom_field_option" USING btree ("field_id","position") WHERE "custom_field_option"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "email_queue_status_created_at_idx" ON "email_queue" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "email_queue_type_created_at_idx" ON "email_queue" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "email_queue_created_at_idx" ON "email_queue" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "email_queue_status_next_attempt_idx" ON "email_queue" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "email_verification_code_email_purpose_idx" ON "email_verification_code" USING btree ("email","purpose");--> statement-breakpoint
CREATE INDEX "event_outbox_pending_idx" ON "event_outbox" USING btree ("processing_lease_expires_at","created_at") WHERE "event_outbox"."realtime_dispatched" = false or "event_outbox"."webhooks_enqueued" = false;--> statement-breakpoint
CREATE INDEX "event_outbox_processed_created_at_idx" ON "event_outbox" USING btree ("created_at") WHERE "event_outbox"."realtime_dispatched" = true and "event_outbox"."webhooks_enqueued" = true;--> statement-breakpoint
CREATE INDEX "event_outbox_workspace_created_at_idx" ON "event_outbox" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "event_outbox_board_created_at_idx" ON "event_outbox" USING btree ("board_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "external_links_workspace_provider_external_uq" ON "external_link" USING btree ("workspace_id","provider","external_type","external_id");--> statement-breakpoint
CREATE INDEX "external_links_workspace_entity_idx" ON "external_link" USING btree ("workspace_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "external_links_workspace_provider_idx" ON "external_link" USING btree ("workspace_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "github_app_singleton_uq" ON "github_app" USING btree ("singleton");--> statement-breakpoint
CREATE UNIQUE INDEX "github_app_installation_client_uq" ON "github_app_installation" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "github_app_installation_client_idx" ON "github_app_installation" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "invite_tokens_client_id_idx" ON "invite_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "invite_tokens_workspace_id_idx" ON "invite_token" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "invite_workspace_grants_workspace_id_idx" ON "invite_workspace_grant" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "internal_links_source_target_uq" ON "internal_link" USING btree ("source_type","source_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "internal_links_workspace_target_idx" ON "internal_link" USING btree ("workspace_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "internal_links_workspace_source_idx" ON "internal_link" USING btree ("workspace_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "kanera_board_import_workspace_created_at_idx" ON "kanera_board_import" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "lists_workspace_id_position_idx" ON "list" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE INDEX "lists_active_workspace_position_idx" ON "list" USING btree ("workspace_id","position") WHERE "list"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "notes_search_vector_idx" ON "note" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "notes_workspace_scope_parent_position_idx" ON "note" USING btree ("workspace_id","board_id","scope","owner_id","parent_note_id","position");--> statement-breakpoint
CREATE INDEX "notes_owner_idx" ON "note" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "note_attachments_client_id_idx" ON "note_attachment" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "note_attachments_note_id_created_at_idx" ON "note_attachment" USING btree ("note_id","created_at");--> statement-breakpoint
CREATE INDEX "note_attachments_uploaded_by_id_idx" ON "note_attachment" USING btree ("uploaded_by_id");--> statement-breakpoint
CREATE INDEX "notifications_user_id_created_at_idx" ON "notification" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_id_unread_idx" ON "notification" USING btree ("user_id","created_at") WHERE "notification"."read_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_activity_uniq" ON "notification" USING btree ("user_id","activity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_overdue_user_card_uniq" ON "notification" USING btree ("user_id","card_id") WHERE "notification"."reason" = 'overdue' and "notification"."card_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_checklist_item_overdue_uniq" ON "notification" USING btree ("user_id","checklist_item_id") WHERE "notification"."reason" = 'checklist_item_overdue' and "notification"."checklist_item_id" is not null;--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "plan_actions_client_id_idx" ON "plan_action" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "push_queue_status_created_at_idx" ON "push_queue" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "push_queue_user_id_created_at_idx" ON "push_queue" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "push_queue_created_at_idx" ON "push_queue" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_uq" ON "push_subscription" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscription" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_client_id_user_id_idx" ON "push_subscription" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_id_active_idx" ON "push_subscription" USING btree ("user_id","updated_at") WHERE "push_subscription"."disabled_at" is null;--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "stripe_events_created_at_idx" ON "stripe_event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "trello_import_workspace_created_at_idx" ON "trello_import" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_client_id_created_at_idx" ON "user" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "users_client_id_client_role_idx" ON "user" USING btree ("client_id","client_role");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_created_at_idx" ON "webhook_delivery" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_workspace_created_at_idx" ON "webhook_delivery" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_next_attempt_idx" ON "webhook_delivery" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_outbox_event_uq" ON "webhook_delivery" USING btree ("endpoint_id","outbox_event_id") WHERE "webhook_delivery"."outbox_event_id" is not null;--> statement-breakpoint
CREATE INDEX "webhook_endpoints_workspace_created_at_idx" ON "webhook_endpoint" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_workspace_enabled_idx" ON "webhook_endpoint" USING btree ("workspace_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_api_keys_hash_uq" ON "workspace_api_key" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "workspace_api_keys_workspace_created_at_idx" ON "workspace_api_key" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "workspace_api_keys_workspace_active_idx" ON "workspace_api_key" USING btree ("workspace_id","created_at") WHERE "workspace_api_key"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "workspaces_client_id_idx" ON "workspace" USING btree ("client_id");--> statement-breakpoint
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
);
