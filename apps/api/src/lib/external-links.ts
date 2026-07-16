import { externalLinks, type ExternalLink, type NewExternalLink } from "@kanera/shared/schema";
import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { db, type Db } from "../db.js";

export type ExternalLinkDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface ExternalLinkLookup {
  workspaceId: string;
  provider: string;
  externalType: string;
  externalId: string;
}

export async function findExternalLink(
  lookup: ExternalLinkLookup,
  database: ExternalLinkDb = db,
): Promise<ExternalLink | null> {
  const [row] = await database
    .select()
    .from(externalLinks)
    .where(and(
      eq(externalLinks.workspaceId, lookup.workspaceId),
      eq(externalLinks.provider, lookup.provider),
      eq(externalLinks.externalType, lookup.externalType),
      eq(externalLinks.externalId, lookup.externalId),
    ))
    .limit(1);
  return row ?? null;
}

export async function upsertExternalLink(
  input: Pick<NewExternalLink, "workspaceId" | "provider" | "externalType" | "externalId" | "entityType" | "entityId">,
  database: ExternalLinkDb = db,
): Promise<ExternalLink> {
  const now = new Date();
  const [row] = await database
    .insert(externalLinks)
    .values({ ...input, updatedAt: now })
    .onConflictDoUpdate({
      target: [
        externalLinks.workspaceId,
        externalLinks.provider,
        externalLinks.externalType,
        externalLinks.externalId,
      ],
      set: {
        entityType: input.entityType,
        entityId: input.entityId,
        updatedAt: now,
      },
    })
    .returning();
  return row!;
}

export async function deleteExternalLinks(
  filters: { workspaceId: string; provider: string; externalType?: string; externalId?: string },
  database: ExternalLinkDb = db,
): Promise<ExternalLink[]> {
  const conditions: SQL[] = [
    eq(externalLinks.workspaceId, filters.workspaceId),
    eq(externalLinks.provider, filters.provider),
  ];
  if (filters.externalType !== undefined) conditions.push(eq(externalLinks.externalType, filters.externalType));
  if (filters.externalId !== undefined) conditions.push(eq(externalLinks.externalId, filters.externalId));
  return database.delete(externalLinks).where(and(...conditions)).returning();
}

export async function listExternalLinksByProvider(
  workspaceId: string,
  provider: string,
  database: ExternalLinkDb = db,
): Promise<ExternalLink[]> {
  return database
    .select()
    .from(externalLinks)
    .where(and(eq(externalLinks.workspaceId, workspaceId), eq(externalLinks.provider, provider)))
    .orderBy(desc(externalLinks.updatedAt));
}

/**
 * Load only links that can belong to the current convergence context. Mirror providers may own
 * thousands of cards, so per-card work must never scan the provider's complete identity map.
 */
export async function findExternalLinks(
  filters: {
    workspaceId: string;
    provider: string;
    externalTypes?: string[];
    externalIds?: string[];
    entityIds?: string[];
  },
  database: ExternalLinkDb = db,
): Promise<ExternalLink[]> {
  const identityConditions: SQL[] = [];
  if (filters.externalIds?.length) identityConditions.push(inArray(externalLinks.externalId, filters.externalIds));
  if (filters.entityIds?.length) identityConditions.push(inArray(externalLinks.entityId, filters.entityIds));
  if ((filters.externalIds || filters.entityIds) && identityConditions.length === 0) return [];
  return database
    .select()
    .from(externalLinks)
    .where(and(
      eq(externalLinks.workspaceId, filters.workspaceId),
      eq(externalLinks.provider, filters.provider),
      filters.externalTypes?.length ? inArray(externalLinks.externalType, filters.externalTypes) : undefined,
      identityConditions.length ? or(...identityConditions) : undefined,
    ))
    .orderBy(desc(externalLinks.updatedAt));
}
