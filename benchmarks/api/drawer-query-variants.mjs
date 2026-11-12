// Experimental SQL only. No rewrite is loaded by production entry points.
import assert from 'node:assert/strict';
export function fixedRecipient(text, values, userId) {
  const index = values.indexOf(userId);
  assert.ok(index >= 0, 'query must already restrict the recipient');
  // Preserve the outer recipient restriction. Only remove redundant correlation inside access
  // subqueries, enabling PostgreSQL to evaluate membership once for the known recipient.
  return text.replaceAll(/("(?:client_member|board_member|card_assignee|card_checklist_item)"\."(?:user_id|assignee_id)" = )"notification"\."user_id"/g, (_match, prefix) => `${prefix}$${index + 1}`);
}
export function splitActivity(text) {
  // Both branches retain the original filters and cursor. UNION (not UNION ALL) preserves OR
  // semantics when a historical event matches both entity_id and payload.cardId.
  const predicate = /\(\("activity_event"\."entity_type" = (\$\d+) and "activity_event"\."entity_id" = (\$\d+)\) or "activity_event"\."payload"->>'cardId' = (\$\d+)\)/;
  const match = text.match(predicate);
  assert.ok(match, 'activity predicate changed');
  const [prefix, order] = text.split(' order by ');
  assert.ok(order && !order.includes(' order by '));
  const direct = prefix.replace(predicate, `("activity_event"."entity_type" = ${match[1]} and "activity_event"."entity_id" = ${match[2]})`);
  const payload = prefix.replace(predicate, `"activity_event"."payload"->>'cardId' = ${match[3]}`);
  // UNION must order by output columns; the creation priority is projected by both branches.
  const priority = `case when "activity_event"."entity_type" = 'card' and "activity_event"."action" = 'created' then 0 else 1 end`;
  const project = q => q.replace(' from "activity_event"', `, ${priority} as "bench_priority" from "activity_event"`);
  const outerOrder = order.replaceAll('"activity_event".', '').replace(priority.replaceAll('"activity_event".', ''),'"bench_priority"');
  return `select * from ((${project(direct)} order by ${order}) union (${project(payload)} order by ${order})) as activity_page order by ${outerOrder}`;
}

export function cardVisibilityExists(text) {
  const join = ' left join "card" on "card"."id" = "notification"."card_id"';
  if (!text.includes(join)) return null;
  const pattern = /"card"\."archived_at" is null\s+and \("notification"\."reason" not in \((\$\d+), (\$\d+)\) or "card"\."completed_at" is null\)/;
  if (!pattern.test(text)) return null;
  const result = text.replace(join, '').replace(pattern, (_match, overdue, checklist) =>
    `not exists (select 1 from "card" archived_card where archived_card.id = "notification"."card_id" and archived_card.archived_at is not null) and ("notification"."reason" not in (${overdue}, ${checklist}) or not exists (select 1 from "card" completed_card where completed_card.id = "notification"."card_id" and completed_card.completed_at is not null))`);
  // Search/hydration can need card fields beyond visibility; don't transform those queries.
  return result.includes('"card".') ? null : result;
}
