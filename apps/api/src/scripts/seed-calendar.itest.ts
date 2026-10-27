import "../test/setup.integration.js";
import { sql } from "drizzle-orm";
import { cards, activityEvents, comments, cardChecklistItems, cardAttachments, notifications, users } from "@kanera/shared/schema";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rm } from "node:fs/promises";
import { db } from "../db.js";
import "../test/integration.js";
import { resolveLocalUploadsRoot } from "../lib/storage/local.js";
import { seedDatabase } from "./seed-data.js";

// A browser run seeds once using today's date. Exercise the whole authored history on each side
// of the weekend deterministically, including the Sunday when London's clocks go back and Tuesday,
// when prematurely projecting Sunday's overdue reminders can collapse the inbox onto Friday.
for (const referenceDate of ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"]) {
  test(`seeded history stays on weekdays with a dated inbox for a ${referenceDate} reset`, async () => {
    await seedDatabase({ referenceDate, passwordHash: "unused-in-calendar-verification" });
    const weekend = await db.execute(sql`
      with history as (
        select 'card created' as kind, title as label, created_at as at from ${cards}
        union all select 'card completed', title, completed_at from ${cards}
        union all select 'activity', action, created_at from ${activityEvents}
        union all select 'comment', id::text, created_at from ${comments}
        union all select 'checklist created', text, created_at from ${cardChecklistItems}
        union all select 'checklist completed', text, completed_at from ${cardChecklistItems}
        union all select 'attachment', id::text, created_at from ${cardAttachments}
      )
      select * from history
      where extract(isodow from at at time zone 'Europe/London') in (6, 7)
      limit 10
    `);
    assert.deepEqual(weekend.rows, [], JSON.stringify(weekend.rows));
    const reversed = await db.execute(sql`
      select title from ${cards} where completed_at < created_at
      union all select text from ${cardChecklistItems} where completed_at < created_at
    `);
    assert.deepEqual(reversed.rows, [], JSON.stringify(reversed.rows));
    const inboxDays = await db.execute<{ days: number }>(sql`
      select count(distinct (${notifications.createdAt} at time zone 'UTC')::date)::int as days
      from ${notifications}
      inner join ${users} on ${users.id} = ${notifications.userId}
      where ${users.email} = 'amelia@kanera.test' and ${notifications.readAt} is null
    `);
    assert.ok((inboxDays.rows[0]?.days ?? 0) >= 2, "Seeded unread notifications must span at least two dates");
  });
}

// Seed media resolves relative upload paths from the repository root, rather than the API cwd.
after(() => rm(resolveLocalUploadsRoot(), { recursive: true, force: true }));
