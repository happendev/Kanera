ALTER TABLE "card" ADD COLUMN "client_token" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "cards_client_token_key" ON "card" USING btree ("client_token") WHERE "card"."client_token" is not null;