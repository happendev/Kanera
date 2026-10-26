CREATE TABLE "user_acquisition" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"attribution" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_acquisition" ADD CONSTRAINT "user_acquisition_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;