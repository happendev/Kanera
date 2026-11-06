import "../test/setup.integration.js";
import { sql } from "drizzle-orm";
import { cards, activityEvents, comments, cardChecklistItems, cardAttachments, notifications, users, boards } from "@kanera/shared/schema";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rm } from "node:fs/promises";
import { db } from "../db.js";
import "../test/integration.js";
import { resolveLocalUploadsRoot } from "../lib/storage/local.js";
import { seedDatabase } from "./seed-data.js";
import { seedCalendar } from "./seed-calendar.js";
import { loadWorkDone } from "../lib/work-done.js";

// A browser run seeds once using today's date. Exercise the whole authored history on each side
// of the weekend deterministically, including the Sunday when London's clocks go back and Tuesday,
// when prematurely projecting Sunday's overdue reminders can collapse the inbox onto Friday.
for (const referenceDate of ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"]) {
  test(`seeded history stays on weekdays with a dated inbox for a ${referenceDate} reset`, async () => {
    const seeded = await seedDatabase({ referenceDate, passwordHash: "unused-in-calendar-verification" });
    // E2E uses empty accounts rather than the demo seed. Check the real history reader here:
    // the final demo edits used to bypass activity, leaving recent human work out of the overview.
    const calendar = seedCalendar(referenceDate);
    const { events } = await loadWorkDone({
      clientId: seeded.primaryClientId,
      boardIds: (await db.select({ id: boards.id }).from(boards)).map((row) => row.id),
      from: new Date(calendar.activityInstant.getTime() - 7 * 86_400_000),
      to: new Date(calendar.activityInstant.getTime() + 1),
    });
    for (const created of seeded.demo.created) {
      const event = events.find((event) => event.card.id === created.id && event.type === "created");
      assert.ok(event, `Missing creation activity for ${created.key}`);
      assert.equal(event.type, "created");
      assert.ok("actorUserId" in event);
      assert.ok(event.actorUserId, `Creation for ${created.key} must count as personal activity`);
    }
    const recentMoves = events.filter((event) => event.type === "moved" && event.at.slice(0, 10) === calendar.previous(1));
    assert.ok(recentMoves.length > 0, "Final demo list moves must appear as recent activity");
    const planningMoves = await db.execute<{ at: string }>(sql`
      select created_at::text as at from ${activityEvents}
      where action = 'moved' and payload->>'fromListName' is null
    `);
    assert.ok(planningMoves.rows.length >= 20);
    assert.equal(new Set(planningMoves.rows.map((row) => row.at)).size, planningMoves.rows.length,
      "The planning pass must not stamp every move at the reset cut-off");
    const creations = events.filter((event) => seeded.demo.created.some((card) => card.id === event.card.id) && event.type === "created");
    assert.equal(new Set(creations.map((event) => event.at)).size, creations.length,
      "Unrelated new cards need distinct authored creation times");
    assert.ok(recentMoves.every((event) => "actorUserId" in event && event.actorUserId), "Authored demo moves need human actors");
    const collapsedWork = await db.execute(sql`
      select created_at, count(distinct entity_id) from ${activityEvents}
      where entity_type = 'card' and action in ('created', 'moved')
        and created_at >= ${new Date(calendar.activityInstant.getTime() - 7 * 86_400_000)}
        and (created_at at time zone 'Europe/London')::time = '17:00:00'
      group by created_at having count(distinct entity_id) > 3
    `);
    assert.deepEqual(collapsedWork.rows, [], "Recent work must not collapse into a batch at 17:00");
    // Reseed across DST as well as weekdays: a fixed base + six hours used to put
    // every delivery-week sign-off at the same 15:13 (or 16:13 in summer) clock time.
    const deliveryMonday = new Date(`${calendar.date}T00:00:00Z`);
    deliveryMonday.setUTCDate(deliveryMonday.getUTCDate() - (deliveryMonday.getUTCDay() + 6) % 7 - 7);
    const deliveryEnd = new Date(deliveryMonday);
    deliveryEnd.setUTCDate(deliveryEnd.getUTCDate() + 5);
    const signoffs = await db.execute<{ clock: string }>(sql`
      select to_char(c.completed_at at time zone 'Europe/London', 'HH24:MI:SS') as clock
      from ${cards} c join ${boards} b on b.id = c.board_id
      where b.name = 'Autumn Campaign Launch'
        and c.completed_at >= ${deliveryMonday} and c.completed_at < ${deliveryEnd}
      order by c.completed_at
    `);
    const clocks = signoffs.rows.map((row) => row.clock);
    assert.equal(clocks.length, 5);
    assert.equal(new Set(clocks).size, 5, "Delivery-week completions must not repeat a clock time");
    assert.ok(new Set(clocks.map((clock) => clock.slice(0, 2))).size >= 3,
      "Sign-offs should span working hours rather than clustering in one hour");
    assert.ok(clocks.every((clock) => clock >= '09:00:00' && clock < '17:00:00'),
      "London sign-offs must stay within the working day across DST changes");
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
    const invalidCardActivity = await db.execute(sql`
      select c.title, a.action from ${activityEvents} a join ${cards} c on c.id = a.entity_id
      where a.entity_type = 'card' and a.action in ('created', 'moved', 'completed')
        and (a.created_at < c.created_at or
          (a.action = 'moved' and c.completed_at is not null and a.created_at > c.completed_at))
      limit 10
    `);
    assert.deepEqual(invalidCardActivity.rows, [], JSON.stringify(invalidCardActivity.rows));
    const reversed = await db.execute(sql`
      select title from ${cards} where completed_at < created_at
      union all select text from ${cardChecklistItems} where completed_at < created_at
    `);
    assert.deepEqual(reversed.rows, [], JSON.stringify(reversed.rows));
    // Browser captures run against today's clock; only deterministic reseeds catch a
    // reset on another weekday putting reminders before their deadlines or comments before cards.
    const invalidInbox = await db.execute(sql`
      select n.id, n.reason from ${notifications} n
      join ${users} u on u.id = n.user_id
      join ${cards} c on c.id = n.card_id
      left join ${activityEvents} a on a.id = n.activity_id
      left join ${comments} m on a.entity_type = 'comment' and m.id = a.entity_id
      where u.email = 'amelia@kanera.test' and n.read_at is null and (
        n.created_at < c.created_at or n.created_at >= ${calendar.instant} or
        (n.reason = 'overdue' and c.due_date_local_date >= (n.created_at at time zone 'Europe/London')::date) or
        (a.entity_type = 'comment' and (m.id is null or m.body = '' or m.created_at <> n.created_at))
      )
    `);
    assert.deepEqual(invalidInbox.rows, [], JSON.stringify(invalidInbox.rows));
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
