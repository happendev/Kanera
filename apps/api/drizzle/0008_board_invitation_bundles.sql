ALTER TABLE "board_invitation" ADD COLUMN "client_id" uuid;
--> statement-breakpoint
UPDATE "board_invitation" bi
SET "client_id" = w."client_id"
FROM "board" b
INNER JOIN "workspace" w ON w."id" = b."workspace_id"
WHERE bi."board_id" = b."id";
--> statement-breakpoint
ALTER TABLE "board_invitation" ALTER COLUMN "client_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "board_invitation" ADD CONSTRAINT "board_invitation_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "board_invitation_grant" (
  "invitation_id" uuid NOT NULL,
  "board_id" uuid NOT NULL,
  "role" "member_role" DEFAULT 'editor' NOT NULL,
  CONSTRAINT "board_invitation_grant_invitation_id_board_id_pk" PRIMARY KEY("invitation_id","board_id")
);
--> statement-breakpoint
ALTER TABLE "board_invitation_grant" ADD CONSTRAINT "board_invitation_grant_invitation_id_board_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."board_invitation"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "board_invitation_grant" ADD CONSTRAINT "board_invitation_grant_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "board_invitation_grant" ("invitation_id", "board_id", "role")
SELECT "id", "board_id", "role"
FROM "board_invitation"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE INDEX "board_invitation_grants_board_id_idx" ON "board_invitation_grant" USING btree ("board_id");
--> statement-breakpoint
CREATE INDEX "board_invitations_client_email_idx" ON "board_invitation" USING btree ("client_id", lower("email"));
