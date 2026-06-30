CREATE TABLE "direct_realtime_outbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"scope" text NOT NULL,
	"user_id" uuid,
	"client_id" uuid,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"realtime_dispatched" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processing_lease_expires_at" timestamp with time zone,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "direct_realtime_outbox_scope_target_chk" CHECK (("direct_realtime_outbox"."scope" = 'user' and "direct_realtime_outbox"."user_id" is not null and "direct_realtime_outbox"."client_id" is null) or ("direct_realtime_outbox"."scope" = 'client' and "direct_realtime_outbox"."client_id" is not null and "direct_realtime_outbox"."user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "direct_realtime_outbox" ADD CONSTRAINT "direct_realtime_outbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_realtime_outbox" ADD CONSTRAINT "direct_realtime_outbox_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "direct_realtime_outbox_pending_idx" ON "direct_realtime_outbox" USING btree ("processing_lease_expires_at","created_at") WHERE "direct_realtime_outbox"."realtime_dispatched" = false;--> statement-breakpoint
CREATE INDEX "direct_realtime_outbox_processed_created_at_idx" ON "direct_realtime_outbox" USING btree ("created_at") WHERE "direct_realtime_outbox"."realtime_dispatched" = true;--> statement-breakpoint
CREATE INDEX "direct_realtime_outbox_user_created_at_idx" ON "direct_realtime_outbox" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "direct_realtime_outbox_client_created_at_idx" ON "direct_realtime_outbox" USING btree ("client_id","created_at");