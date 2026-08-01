import { CARD_KEY_PREFIX_PATTERN, cardKeyPrefixReservations, cards, clients, workspaces } from "@kanera/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db.js";
import { badRequest, conflict, notFound } from "./errors.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface AllocatedCardIdentity {
  workspaceId: string;
  organisationKey: string;
  number: number;
  key: string;
}

export interface ResolvedCardIdentity extends AllocatedCardIdentity {
  id: string;
  boardId: string;
  listId: string;
}

export function formatCardKey(prefix: string, number: number): string {
  return `${prefix}-${number}`;
}

export function normalizeCardKeyPrefix(prefix: string): string {
  const normalized = prefix.trim().toUpperCase();
  if (!CARD_KEY_PREFIX_PATTERN.test(normalized)) {
    throw badRequest("card key prefix must match ^[A-Z][A-Z0-9]{1,9}$");
  }
  return normalized;
}

/** Resolves current keys and permanent prefix aliases without applying viewer access rules. */
export async function resolveCardKey(tx: Tx, organisationKey: string, rawKey: string): Promise<ResolvedCardIdentity | null> {
  const match = /^([A-Z][A-Z0-9]{1,9})-([1-9][0-9]*)$/.exec(rawKey.toUpperCase());
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) return null;
  const [card] = await tx
    .select({
      id: cards.id,
      workspaceId: cards.workspaceId,
      organisationKey: cards.organisationKey,
      boardId: cards.boardId,
      listId: cards.listId,
      number: cards.number,
      key: cards.key,
    })
    .from(cardKeyPrefixReservations)
    .innerJoin(clients, eq(clients.id, cardKeyPrefixReservations.clientId))
    .innerJoin(cards, and(
      eq(cards.workspaceId, cardKeyPrefixReservations.workspaceId),
      eq(cards.number, number),
    ))
    .where(and(
      eq(clients.routeKey, organisationKey.toUpperCase()),
      eq(cardKeyPrefixReservations.prefix, match[1]!),
    ))
    .limit(1);
  return card ?? null;
}

function defaultPrefixBase(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "")
    .replace(/^[^A-Z]+/u, "")
    .slice(0, 10);
  if (normalized.length >= 2) return normalized;
  if (normalized.length === 1) return `${normalized}X`;
  return "WS";
}

function suffixedPrefix(base: string, collisionIndex: number): string {
  if (collisionIndex === 0) return base.slice(0, 10);
  const suffix = String(collisionIndex + 1);
  return `${base.slice(0, Math.max(1, 10 - suffix.length))}${suffix}`;
}

/** Permanently reserves either the requested prefix or the first available name-derived variant. */
export async function reserveCardKeyPrefix(
  tx: Tx,
  params: { clientId: string; workspaceId: string; workspaceName: string; requestedPrefix?: string },
): Promise<string> {
  const requested = params.requestedPrefix === undefined ? null : normalizeCardKeyPrefix(params.requestedPrefix);
  const base = requested ?? defaultPrefixBase(params.workspaceName);
  // A bounded loop protects against pathological databases while still allowing far more same-name
  // workspaces than a real installation will create.
  for (let collisionIndex = 0; collisionIndex < 100_000; collisionIndex += 1) {
    const prefix = requested ?? suffixedPrefix(base, collisionIndex);
    const [reserved] = await tx
      .insert(cardKeyPrefixReservations)
      .values({ clientId: params.clientId, prefix, workspaceId: params.workspaceId })
      .onConflictDoNothing()
      .returning({ prefix: cardKeyPrefixReservations.prefix });
    if (reserved) return reserved.prefix;
    if (requested) {
      const [owner] = await tx
        .select({ workspaceId: cardKeyPrefixReservations.workspaceId })
        .from(cardKeyPrefixReservations)
        .where(and(
          eq(cardKeyPrefixReservations.clientId, params.clientId),
          eq(cardKeyPrefixReservations.prefix, requested),
        ))
        .limit(1);
      // A workspace may intentionally switch back to one of its own historical aliases, but no
      // reservation can ever cross workspace ownership (including after deletion).
      if (owner?.workspaceId === params.workspaceId) return requested;
      throw conflict("card key prefix is already reserved");
    }
  }
  throw conflict("could not generate an available card key prefix");
}

/**
 * Locks the workspace counter and allocates one contiguous range. Keeping this increment inside the
 * caller's transaction means a failed create rolls the counter back and never creates a gap.
 */
export async function allocateCardKeys(tx: Tx, workspaceId: string, count: number): Promise<AllocatedCardIdentity[]> {
  if (!Number.isInteger(count) || count < 0) throw new Error("card key allocation count must be a non-negative integer");
  if (count === 0) return [];
  const result = await tx.execute<{ organisationKey: string; cardKeyPrefix: string; lastCardNumber: number }>(sql`
    update ${workspaces}
    set last_card_number = last_card_number + ${count}
    from ${clients}
    where ${workspaces.id} = ${workspaceId}
      and ${clients.id} = ${workspaces.clientId}
    returning ${clients.routeKey} as "organisationKey", card_key_prefix as "cardKeyPrefix", last_card_number as "lastCardNumber"
  `);
  const row = result.rows[0];
  if (!row) throw notFound("workspace not found");
  const end = Number(row.lastCardNumber);
  const start = end - count + 1;
  return Array.from({ length: count }, (_, index) => {
    const number = start + index;
    return { workspaceId, organisationKey: row.organisationKey, number, key: formatCardKey(row.cardKeyPrefix, number) };
  });
}

/** Reserves a new prefix, rewrites materialized keys, and keeps every prior reservation as an alias. */
export async function changeWorkspaceCardKeyPrefix(tx: Tx, workspaceId: string, requestedPrefix: string) {
  const [current] = await tx
    .select({ clientId: workspaces.clientId, name: workspaces.name, cardKeyPrefix: workspaces.cardKeyPrefix })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!current) throw notFound("workspace not found");
  const prefix = normalizeCardKeyPrefix(requestedPrefix);
  if (prefix === current.cardKeyPrefix) return prefix;

  await reserveCardKeyPrefix(tx, {
    clientId: current.clientId,
    workspaceId,
    workspaceName: current.name,
    requestedPrefix: prefix,
  });
  // The database trigger rewrites every materialized card key in the same transaction. Keeping
  // that invariant beside the workspace row also covers administrative and seed tooling.
  await tx.update(workspaces).set({ cardKeyPrefix: prefix, updatedAt: new Date() }).where(eq(workspaces.id, workspaceId));
  return prefix;
}
