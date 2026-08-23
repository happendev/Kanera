ALTER TABLE "client" ADD COLUMN "default_completed_cards_active_days" integer DEFAULT 35 NOT NULL;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "default_inactive_cards_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "default_board_health_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "inactive_cards_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "board_health_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "board_health_overdue_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "board_health_unassigned_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "board_health_inactive_enabled" boolean DEFAULT true NOT NULL;