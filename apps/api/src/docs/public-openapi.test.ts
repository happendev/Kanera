import { getTableColumns } from "drizzle-orm";
import * as schema from "@kanera/shared/schema";
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicOpenApiDocument } from "./public-openapi.js";

/**
 * The published contract is hand-written, and the failure mode that actually bites is silent:
 * a new column lands on a table that the public API already returns, and nobody notices the docs
 * never grew a matching property. Generating the document is not worth it (requests already reuse
 * the Zod DTOs; these are response schemas, and response contracts in `packages/shared` are TS
 * interfaces, not Zod). This test closes the same gap far more cheaply.
 *
 * Each entry is a decision record, not an assertion that the current contract is ideal:
 *
 * - `synthetic` — documented properties with no column behind them: computed values, joined
 *   denormalisations, and nested collections.
 * - `omitted` — columns deliberately absent from the public contract.
 *
 * Both are exact. Adding a column, renaming one, or adding a documented property fails here until
 * someone decides which list it belongs in — which is the whole point.
 */
const ENTITIES: { name: string; table: unknown; synthetic?: string[]; omitted?: string[] }[] = [
  {
    name: "Workspace",
    table: schema.workspaces,
    synthetic: ["role"],
    // `lastCardNumber` is the card-key allocation counter, an internal implementation detail.
    omitted: ["lastCardNumber", "boardLinkingEnabled", "archivedAt"],
  },
  { name: "Board", table: schema.boards, omitted: ["groupId", "archivedAt"] },
  { name: "List", table: schema.lists, omitted: ["icon", "color"] },
  {
    name: "Card",
    table: schema.cards,
    // `url` is built from the organisation key and card key rather than stored.
    synthetic: ["url"],
    // `clientToken` is idempotency bookkeeping and `searchVector` is a tsvector index column;
    // neither is meaningful to an API consumer.
    omitted: ["clientToken", "dueDateTimezone", "createdById", "coverAttachmentId", "searchVector"],
  },
  {
    name: "CardAttachment",
    table: schema.cardAttachments,
    // Published as `sizeBytes`; stored as `byteSize`.
    synthetic: ["sizeBytes"],
    // Storage keys are internal: the contract exposes signed URLs instead, so a consumer can
    // never come to depend on the bucket layout.
    omitted: [
      "clientId", "uploadedById", "byteSize", "fileKey", "thumbnailFileKey", "coverImageFileKey",
      "coverImageWidth", "coverImageHeight", "coverImageColor", "source", "commentId", "searchVector",
    ],
  },
  { name: "CustomField", table: schema.customFields, synthetic: ["options"], omitted: ["showOnCard"] },
  { name: "CustomFieldOption", table: schema.customFieldOptions },
  { name: "CardLabel", table: schema.cardLabels, omitted: ["archivedAt"] },
  { name: "Checklist", table: schema.cardChecklists, synthetic: ["items"], omitted: ["createdAt", "updatedAt"] },
  { name: "ChecklistItem", table: schema.cardChecklistItems },
  {
    name: "Note",
    table: schema.notes,
    synthetic: ["lastEditedByName", "lastEditedByAvatarUrl"],
    omitted: ["searchVector"],
  },
  {
    name: "User",
    table: schema.users,
    synthetic: ["clientRole"],
    // Credentials, per-user UI preferences, and soft-deletion bookkeeping are never public.
    omitted: [
      "activeClientId", "emailVerifiedAt", "passwordHash", "timezone", "showCardKeys",
      "showScratchpad", "lastOnlineAt", "deletedAt", "needsOrganisationOnLoginAt",
    ],
  },
  {
    name: "BoardMember",
    table: schema.boardMembers,
    synthetic: ["email", "displayName", "avatarUrl", "lastOnlineAt", "clientId"],
    omitted: ["addedAt"],
  },
  { name: "WorkspaceMember", table: schema.workspaceMembers, synthetic: ["user"], omitted: ["addedAt"] },
  { name: "ExternalLink", table: schema.externalLinks },
  {
    name: "NoteAttachment",
    table: schema.noteAttachments,
    synthetic: ["uploadedByName", "uploadedByAvatarUrl"],
    omitted: ["clientId", "fileKey"],
  },
  {
    name: "Comment",
    table: schema.comments,
    synthetic: ["authorName", "authorAvatarUrl", "reactions"],
    omitted: ["searchVector"],
  },
];

void test("public OpenAPI table-backed schemas have not drifted from their tables", () => {
  const components = publicOpenApiDocument.components as { schemas: Record<string, { properties?: Record<string, unknown> }> };
  for (const entity of ENTITIES) {
    const documented = components.schemas[entity.name];
    assert.ok(documented, `public OpenAPI is missing a schema for ${entity.name}`);
    const columns = new Set(Object.keys(getTableColumns(entity.table as Parameters<typeof getTableColumns>[0])));
    const properties = new Set(Object.keys(documented.properties ?? {}));

    assert.deepEqual(
      [...properties].filter((name) => !columns.has(name)).sort(),
      [...(entity.synthetic ?? [])].sort(),
      `${entity.name}: documented properties with no matching column changed. A renamed or dropped column leaves the docs describing a field the API no longer returns.`,
    );
    assert.deepEqual(
      [...columns].filter((name) => !properties.has(name)).sort(),
      [...(entity.omitted ?? [])].sort(),
      `${entity.name}: undocumented columns changed. A new column is either part of the public contract (document it) or deliberately internal (add it to \`omitted\`).`,
    );
  }
});
