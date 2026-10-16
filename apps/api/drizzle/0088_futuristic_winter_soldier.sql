CREATE TABLE "card_in_progress_alert" (
	"card_id" uuid PRIMARY KEY NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card_in_progress_alert" ADD CONSTRAINT "card_in_progress_alert_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Preserve existing flags on upgrade, including those whose JS timestamps lost microseconds.
INSERT INTO "card_in_progress_alert" ("card_id", "fired_at")
SELECT c.id, min(a.created_at)
FROM activity_event a
JOIN card c ON c.id = a.entity_id
WHERE a.entity_type = 'card' AND a.action = 'inProgress:tooLong'
GROUP BY c.id
ON CONFLICT DO NOTHING;
