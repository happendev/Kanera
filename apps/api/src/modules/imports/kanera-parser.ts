import { COLOR_TOKENS, type ColorToken } from "@kanera/shared/colors";
import type { BoardExportArchive, KaneraBoardImportManifest } from "@kanera/shared/dto";
import { kaneraBoardImportArchive } from "@kanera/shared/dto";
import type { ParsedKaneraBoardImport } from "./types.js";

const COLOR_TOKEN_SET = new Set<string>(COLOR_TOKENS);

function toIso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date || typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  if (!date) return null;
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function colorToken(value: unknown, fallback: ColorToken | null = null): ColorToken | null {
  return typeof value === "string" && COLOR_TOKEN_SET.has(value) ? value as ColorToken : fallback;
}

export function parseKaneraBoardExport(raw: unknown): ParsedKaneraBoardImport {
  const source = kaneraBoardImportArchive.parse(raw) as unknown as BoardExportArchive;
  const cardIds = new Set(source.cards.map((card) => card.id));
  const listCardCounts = new Map<string, number>();
  for (const card of source.cards) {
    listCardCounts.set(card.listId, (listCardCounts.get(card.listId) ?? 0) + 1);
  }

  const manifest: KaneraBoardImportManifest = {
    source: "kanera",
    board: {
      name: source.board.name,
      desc: source.board.description ?? null,
      icon: source.board.icon,
      iconColor: colorToken(source.board.iconColor),
    },
    lists: source.lists.map((list) => ({
      id: list.id,
      name: list.name,
      closed: !!list.archivedAt,
      archivedAt: toIso(list.archivedAt),
      cardCount: listCardCounts.get(list.id) ?? 0,
    })),
    labels: source.labels.map((label) => ({
      id: label.id,
      name: label.name,
      trelloColor: label.color,
      suggestedToken: colorToken(label.color, "gray")!,
      archivedAt: toIso(label.archivedAt),
    })),
    customFields: source.customFields.map((field) => ({
      id: field.id,
      name: field.name,
      trelloType: field.type,
      suggestedType: field.type,
      allowMultiple: field.allowMultiple,
      archivedAt: toIso(field.archivedAt),
      ...(field.options.length ? { options: field.options.map((option) => ({ id: option.id, label: option.label, color: colorToken(option.color) })) } : {}),
    })),
    members: source.members.map((member) => ({
      id: member.userId,
      fullName: member.displayName,
      email: member.email ?? null,
      username: null,
      source: member.source,
      boardRole: member.boardRole,
    })),
    counts: {
      cards: source.cards.length,
      checklists: source.checklists.length,
      comments: source.comments.length,
      linkAttachments: 0,
      uploadedAttachments: source.attachments.filter((attachment) => cardIds.has(attachment.cardId)).length,
    },
  };

  return { manifest, source };
}
