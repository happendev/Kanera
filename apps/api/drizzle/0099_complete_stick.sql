CREATE TABLE "invite_board_grant" (
	"invite_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"role" text DEFAULT 'editor' NOT NULL,
	CONSTRAINT "invite_board_grant_invite_id_board_id_pk" PRIMARY KEY("invite_id","board_id"),
	CONSTRAINT "invite_board_grants_role_ck" CHECK ("invite_board_grant"."role" in ('editor', 'observer'))
);
--> statement-breakpoint
ALTER TABLE "invite_board_grant" ADD CONSTRAINT "invite_board_grant_invite_id_invite_token_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invite_token"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_board_grant" ADD CONSTRAINT "invite_board_grant_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invite_board_grants_board_id_idx" ON "invite_board_grant" USING btree ("board_id");