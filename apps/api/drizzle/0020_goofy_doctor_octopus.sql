ALTER TABLE "board_invitation_grant" ADD COLUMN "assigned_items_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "board_invitation" ADD COLUMN "assigned_items_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "board_member" ADD COLUMN "assigned_items_only" boolean DEFAULT false NOT NULL;