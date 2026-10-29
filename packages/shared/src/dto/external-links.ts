import { z } from "zod";
import type { ExternalLink } from "../schema/external-link.js";
import { GENERAL_NAME_MAX_LENGTH } from "./name-limits.js";

const externalLinkName = z
  .string()
  .trim()
  .min(1)
  .max(GENERAL_NAME_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "use letters, numbers, dots, underscores, colons, or hyphens");

export const externalLinkEntityType = z.enum([
  "card",
  "comment",
  "cardAttachment",
  "cardChecklist",
  "cardChecklistItem",
]);
export type ExternalLinkEntityType = z.infer<typeof externalLinkEntityType>;

export const listExternalLinksQuery = z.object({
  provider: externalLinkName.optional(),
  externalType: externalLinkName.optional(),
  externalId: z.string().trim().min(1).max(500).optional(),
  entityType: externalLinkEntityType.optional(),
  entityId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListExternalLinksQuery = z.infer<typeof listExternalLinksQuery>;

// Compact identity used when linking a newly created card in the same transaction.
export const cardExternalRef = z.object({
  provider: externalLinkName.describe("Integration provider, such as sentry. The mirror: namespace is reserved."),
  type: externalLinkName.describe("Provider entity type, such as issue."),
  id: z.string().trim().min(1).max(500).describe("Identifier in the provider; unique with provider and type within this workspace."),
});

export const upsertExternalLinkBody = z.object({
  provider: externalLinkName,
  externalType: externalLinkName,
  externalId: z.string().trim().min(1).max(500),
  entityType: externalLinkEntityType,
  entityId: z.uuid(),
});
export type UpsertExternalLinkBody = z.infer<typeof upsertExternalLinkBody>;

export type ExternalLinkRow = Pick<
  ExternalLink,
  "id" | "workspaceId" | "provider" | "externalType" | "externalId" | "entityType" | "entityId" | "createdAt" | "updatedAt"
>;
