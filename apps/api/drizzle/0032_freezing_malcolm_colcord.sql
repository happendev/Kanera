ALTER TABLE "board" ALTER COLUMN "icon" SET DEFAULT 'layout-kanban';--> statement-breakpoint
ALTER TABLE "list" ALTER COLUMN "icon" SET DEFAULT 'list';--> statement-breakpoint
ALTER TABLE "note" ALTER COLUMN "icon" SET DEFAULT 'file-text';--> statement-breakpoint
ALTER TABLE "workspace" ALTER COLUMN "icon" SET DEFAULT 'rocket';
--> statement-breakpoint
UPDATE "board" SET "icon" = 'layout-kanban' WHERE "icon" IS NULL;
--> statement-breakpoint
UPDATE "list" SET "icon" = 'list' WHERE "icon" IS NULL;
--> statement-breakpoint
UPDATE "note" SET "icon" = 'file-text' WHERE "icon" IS NULL;
--> statement-breakpoint
UPDATE "workspace" SET "icon" = 'rocket' WHERE "icon" IS NULL;
