/**
 * Repeatable synthetic backend performance proof. Never accepts a normal development/production
 * database name. See backend-proof.sh: a fresh migrated database is created and removed per run.
 * `full` deliberately uses the still-supported full timeline to reproduce pre-fix page hydration.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must name a fresh isolated performance database");
const parsed = new URL(databaseUrl);
if (!["localhost", "127.0.0.1"].includes(parsed.hostname) || !/^\/kanera_test_perf_[a-z0-9_]+$/.test(parsed.pathname)) {
  throw new Error("Refusing to run performance fixtures outside a local kanera_test_perf_* database");
}
const uuid = (value) => {
  const hash = createHash("md5").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
};
const mode = process.argv[2] ?? "paged";
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
if (mode === "seed") {
  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query("select count(*)::integer as count from client");
    assert.equal(rows[0].count, 0, "fixture seeding requires an empty migrated database");
    const source = await readFile(new URL("backend-fixture.sql", import.meta.url), "utf8");
    await client.query(source.replace(/^\\set[^\n]*\n/gm, ""));
    await client.query(`with numbered as (
      select id,row_number() over (partition by entity_id order by created_at) as n
      from activity_event where client_id=$1 and entity_type='card'
    ) update activity_event a set action=case when numbered.n=1 then 'created' else 'moved' end
      from numbered where a.id=numbered.id`, [uuid("client1")]);
    await client.query(`insert into internal_link(workspace_id,source_type,source_id,target_type,target_id)
      select $1,'card',$2,'card',md5('card'||n)::uuid from generate_series(2,101) n`, [uuid("workspace1"), uuid("card1")]);
    console.log(JSON.stringify({ mode, organisations: 10, boards: 100, cards: 50_000, activities: 300_000, historyCards: 5_000, rawHistoryEvents: 20_000 }));
  } finally {
    await client.end();
  }
  process.exit(0);
}

const { pool } = await import("../../apps/api/src/db.ts");
let queryRows = 0;
let queryCount = 0;
const prepared = {};
const instrumented = new WeakSet();
pool.on("acquire", (client) => {
  if (instrumented.has(client)) return;
  instrumented.add(client);
  const original = client.query.bind(client);
  client.query = (...args) => {
    queryCount++;
    const query = args[0];
    if (query?.name) prepared[query.name] = (prepared[query.name] ?? 0) + 1;
    const record = (result) => { queryRows += result?.rowCount ?? 0; return result; };
    if (typeof args.at(-1) === "function") {
      const callback = args.pop();
      return original(...args, (error, result) => callback(error, record(result)));
    }
    return original(...args).then(record);
  };
});
const options = {
  clientId: uuid("client1"), boardIds: Array.from({ length: 10 }, (_, index) => uuid(`board${index + 1}`)),
  actorUserId: uuid("user1"), from: new Date(Date.now() - 4 * 86_400_000), to: new Date(), timeZone: "UTC",
};
try {
  if (mode === "full" || mode === "paged") {
    const { loadWorkDone, loadWorkDonePage } = await import("../../apps/api/src/lib/work-done.ts");
    global.gc?.();
    const before = process.memoryUsage();
    const started = performance.now();
    const response = mode === "full" ? await loadWorkDone(options) : await loadWorkDonePage(options, { limit: 50 });
    const durationMs = performance.now() - started;
    const after = process.memoryUsage();
    console.log(JSON.stringify({
      mode, durationMs, materializedEvents: response.events.length, returnedEvents: Math.min(response.events.length, 50),
      queryRows, queryCount, heapGrowthBytes: after.heapUsed - before.heapUsed,
      rssGrowthBytes: after.rss - before.rss, maxRssKiB: process.resourceUsage().maxRSS,
    }));
  } else if (mode === "parity") {
    const { loadWorkDone, loadWorkDonePage } = await import("../../apps/api/src/lib/work-done.ts");
    const expected = (await loadWorkDone(options)).events;
    const first = await loadWorkDonePage(options, { limit: 50 });
    const last = first.events.at(-1);
    const second = await loadWorkDonePage(options, { limit: 50, cursor: { at: last.at, id: last.id } });
    assert.deepEqual(first.events, expected.slice(0, 50));
    assert.deepEqual(second.events, expected.slice(50, 100));
    assert.equal(first.summary.totalEvents, expected.length);
    assert.deepEqual(second.summary, first.summary);
    console.log(JSON.stringify({ mode, passed: true, totalEvents: expected.length, pagesCompared: 2 }));
  } else if (mode === "links") {
    const { loadLinkedNotesForCard } = await import("../../apps/api/src/lib/internal-links.ts");
    for (let sample = 0; sample < 3; sample++) {
      queryCount = 0; queryRows = 0; for (const name of Object.keys(prepared)) delete prepared[name];
      const started = performance.now();
      const rows = await loadLinkedNotesForCard({ sub: uuid("user1"), cid: uuid("client1"), role: "owner" }, uuid("card1"), uuid("workspace1"));
      assert.equal(rows.length, 100);
      assert.equal(prepared.boardAccess, 1, "100 same-board links must authorize the board once");
      console.log(JSON.stringify({ mode, sample, durationMs: performance.now() - started, rows: rows.length, queryCount, prepared }));
    }
  } else if (mode === "indexes") {
    // The legacy/current comparisons run only in this disposable synthetic database. The actual
    // predicate is unchanged, preserving payload references on historical card events as well.
    const indexes = [
      ["activity_events_entity_created_at_idx", "create index activity_events_entity_created_at_idx on activity_event(entity_type,entity_id,created_at)"],
      ["activity_events_payload_card_created_at_idx", "create index activity_events_payload_card_created_at_idx on activity_event((payload->>'cardId'),created_at) where feed_visible=true and payload->>'cardId' is not null"],
    ];
    const inactivity = `select count(*) from card c join board b on b.id=c.board_id join workspace w on w.id=b.workspace_id
      where w.id=$1 and c.archived_at is null and not exists (select 1 from activity_event a where
      ((a.entity_type='card' and a.entity_id=c.id) or a.payload->>'cardId'=c.id::text)
      and a.feed_visible=true and a.created_at>=now()-interval '1 hour')`;
    const mirrors = `select entity_id,payload->>'mirrorId' from activity_event where entity_type='comment'
      and entity_id=any($1::uuid[]) and payload->>'mirrorId' is not null`;
    for (const [index] of indexes) await pool.query(`drop index if exists ${index}`);
    try {
      for (const stage of ["before", "after"]) {
        if (stage === "after") for (const [, create] of indexes) await pool.query(create);
        await pool.query("analyze activity_event");
        for (const [name, text, values] of [["inactivity", inactivity, [uuid("workspace1")]], ["commentProvenance", mirrors, [[3, 6, 9].map((n) => uuid(`comment${n}`))]]]) {
          const { rows } = await pool.query(`explain (analyze,buffers,format json) ${text}`, values);
          console.log(JSON.stringify({ mode, stage, query: name, plan: rows[0]["QUERY PLAN"][0] }));
        }
      }
    } finally {
      for (const [, create] of indexes) await pool.query(create.replace("create index ", "create index if not exists "));
    }
  } else throw new Error(`Unknown proof mode: ${mode}`);
} finally {
  await pool.end();
}
process.exit(0);
