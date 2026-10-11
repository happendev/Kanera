/**
 * Benchmark-only SQL variants for the board summary query. Production continues using its
 * checked-in query. Apply these only to the filtered_cards summary query, never globally to
 * pg type parsers: other endpoints expect complete custom-field objects and PostgreSQL arrays.
 */
import assert from 'node:assert/strict';

export const SUMMARY_QUERY_VARIANTS = Object.freeze([
  'baseline',
  'pg-arrays',
  'sql-compact',
  'json-arrays',
  'sql-combined',
  'lean-cover',
  'sql-all',
  'json-rows',
  'sql-all-json-rows',
  'sql-absent',
  'sql-absent-combined',
  'sql-absent-json-rows',
]);

function replaceOnce(text, before, after) {
  const offset = text.indexOf(before);
  assert.notEqual(offset, -1, `Board summary query changed; missing expected fragment: ${before}`);
  assert.equal(text.indexOf(before, offset + before.length), -1,
    `Board summary query changed; duplicate fragment: ${before}`);
  return text.slice(0, offset) + after + text.slice(offset + before.length);
}

function compactCustomFields(text) {
  // json_strip_nulls removes null-valued object properties, preserving false, zero, empty
  // strings, empty arrays, and null elements inside arrays. The existing HTTP compactor drops
  // these same null value fields after pg has otherwise paid to receive and parse them.
  text = replaceOnce(text, 'json_build_object(\n            \'cardId\'', 'json_strip_nulls(json_build_object(\n            \'cardId\'');
  return replaceOnce(text,
    "'updatedAt', cfv.updated_at\n          )",
    "'updatedAt', cfv.updated_at\n          ))");
}

function absentCustomFields(text) {
  // PostgreSQL 16+'s SQL/JSON constructor can omit null properties during construction,
  // avoiding the second parse/walk required by json_strip_nulls(json_build_object(...)).
  const before = /json_build_object\(\n            'cardId',[\s\S]*?'updatedAt', cfv\.updated_at\n          \)/;
  const matches = text.match(new RegExp(before.source, 'g'));
  assert.equal(matches?.length, 1, 'Expected one custom-field JSON constructor');
  const after = matches[0]
    .replace('json_build_object(', 'json_object(')
    .replace(/'([^']+)', (cfv\.[a-z_]+(?:::text)?)/g, "'$1' VALUE $2")
    .replace(/\n          \)$/, '\n          ABSENT ON NULL RETURNING json)');
  return text.replace(before, after);
}

function identifierArrays(text, json = true) {
  // The product now uses JSON arrays. Keep the old transport as an explicit control and
  // accept historical SQL captures so saved experiments can still be reproduced.
  for (const [expression, alias] of [
    ['cla.label_id order by cla.assigned_at, cla.label_id', 'label_ids'],
    ['ca.user_id order by ca.assigned_at, ca.user_id', 'assignee_ids'],
  ]) {
    const oldAggregate = `array_agg(${expression}) as ${alias}`;
    const newAggregate = `json_agg(${expression}) as ${alias}`;
    const sourceJson = text.includes(newAggregate);
    text = replaceOnce(text, sourceJson ? newAggregate : oldAggregate, json ? newAggregate : oldAggregate);
    text = replaceOnce(text,
      `coalesce(${alias}.${alias}, ${sourceJson ? "'[]'::json" : "'{}'::uuid[]"})`,
      `coalesce(${alias}.${alias}, ${json ? "'[]'::json" : "'{}'::uuid[]"})`);
  }
  return text;
}

function leanCover(text) {
  // toWireCardSummary reads URL references, not these file keys/mime. Keep the URL selection
  // and signing on the application path unchanged to isolate the cost of unused columns.
  for (const column of [
    'cover.file_key as "coverFileKey",',
    'cover.mime_type as "coverMimeType",',
    'cover.thumbnail_file_key as "coverThumbnailFileKey",',
    'cover.cover_image_file_key as "coverImageFileKey",',
  ]) text = replaceOnce(text, `      ${column}\n`, '');
  return text;
}

function aggregateRowsAsJson(text) {
  // Native JSON parsing can replace thousands of pg row objects and individual column decodes.
  // Preserve the existing raw Drizzle result types: its timestamp parser returns PostgreSQL
  // text verbatim, and numeric positions must remain strings to retain ordering precision.
  for (const [expression, alias] of [
    ['fc.position', null],
    ['fc.completed_at', 'completedAt'],
    ['fc.archived_at', 'archivedAt'],
    ['fc.created_at', 'createdAt'],
    ['fc.updated_at', 'updatedAt'],
  ]) {
    const before = alias ? `${expression} as "${alias}"` : `      ${expression},\n`;
    const after = alias ? `${expression}::text as "${alias}"` : `      ${expression}::text as position,\n`;
    text = replaceOnce(text, before, after);
  }
  return `select coalesce(json_agg(row_to_json(board_card_rows)), '[]'::json) as "__boardCardRows" from (\n${text}\n) board_card_rows`;
}

/** Transform only the known board-card-summary SQL; unknown variants or query drift fail closed. */
export function transformSummaryQuery(text, variant = 'baseline') {
  assert.ok(SUMMARY_QUERY_VARIANTS.includes(variant), `Unknown board summary query variant: ${variant}`);
  if (variant === 'baseline') return text;
  assert.match(text, /with filtered_cards as materialized\s*\(/,
    'Only the board-card-summary SQL can be transformed');
  if (variant === 'pg-arrays') return identifierArrays(text, false);
  if (['sql-compact', 'sql-combined', 'sql-all', 'sql-all-json-rows'].includes(variant)) text = compactCustomFields(text);
  if (['sql-absent', 'sql-absent-combined', 'sql-absent-json-rows'].includes(variant)) text = absentCustomFields(text);
  if (['json-arrays', 'sql-combined', 'sql-all', 'sql-all-json-rows', 'sql-absent-combined', 'sql-absent-json-rows'].includes(variant)) text = identifierArrays(text);
  if (['lean-cover', 'sql-all', 'sql-all-json-rows', 'sql-absent-combined', 'sql-absent-json-rows'].includes(variant)) text = leanCover(text);
  if (['json-rows', 'sql-all-json-rows', 'sql-absent-json-rows'].includes(variant)) text = aggregateRowsAsJson(text);
  return text;
}

/** Restore the rows shape for envelope variants in a benchmark pg.Client.query wrapper. */
export function transformSummaryResult(result, variant = 'baseline') {
  if (!['json-rows', 'sql-all-json-rows', 'sql-absent-json-rows'].includes(variant)) return result;
  const rows = result.rows[0]?.__boardCardRows;
  assert.ok(Array.isArray(rows), 'Expected one parsed board-card JSON envelope');
  return { ...result, rows, rowCount: rows.length };
}

/** Compare decoded HTTP responses exactly, including nested types, order, nulls and false. */
export function assertEquivalentBoardResponses(actual, expected) {
  // Fixture covers use deterministic public asset URLs. For private-media fixtures, freeze time
  // instead of silently accepting arbitrary signature/expiration differences.
  assert.deepEqual(actual, expected);
}
