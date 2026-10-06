ALTER TABLE "client" DROP COLUMN "default_board_health_enabled";--> statement-breakpoint
ALTER TABLE "workspace" DROP COLUMN "board_health_enabled";--> statement-breakpoint
ALTER TABLE "workspace" DROP COLUMN "board_health_overdue_enabled";--> statement-breakpoint
ALTER TABLE "workspace" DROP COLUMN "board_health_unassigned_enabled";--> statement-breakpoint
ALTER TABLE "workspace" DROP COLUMN "board_health_inactive_enabled";