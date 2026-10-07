import { cardPath } from "@kanera/shared/card-links";
import type { WireCard } from "@kanera/shared/events";
import type { Card } from "@kanera/shared/schema";
import type { TxOnly as Tx } from "../../db.js";

const CHUNK_SIZE = 500;

/** Runs `fn` over `items` with at most `limit` in flight, preserving result order. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function chunks<T>(items: T[], size = CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

/** Inserts in bounded batches so a large import never exceeds Postgres' bind-parameter limit. */
export async function insertMany<T extends Record<string, unknown>, R>(tx: Tx, table: Parameters<Tx["insert"]>[0], rows: T[]): Promise<R[]> {
  const inserted: R[] = [];
  for (const chunk of chunks(rows)) {
    if (chunk.length === 0) continue;
    inserted.push(...await tx.insert(table).values(chunk).returning() as R[]);
  }
  return inserted;
}

/**
 * Import results carry the relative card path rather than an absolute URL: the importer runs inside
 * one transaction and its summary is consumed by the same web origin that requested it.
 */
export function toWireImportedCard(card: Card): WireCard {
  return { ...card, url: cardPath(card.organisationKey, card.key) };
}
