import assert from "node:assert/strict";
import { test } from "node:test";
import { ZodError } from "zod";
import { parseKaneraBoardExport } from "./kanera-parser.js";
import { parseTrelloExport } from "./parser.js";

void test("parseTrelloExport normalizes a Trello export manifest and source", () => {
  const parsed = parseTrelloExport({
      id: "board-1",
      name: "Launch",
      desc: "Ship it",
      lists: [
        { id: "list-done", name: "Done", closed: false, pos: 2 },
        { id: "list-todo", name: "Todo", closed: false, pos: 1 },
      ],
      labels: [{ id: "label-1", name: "Important", color: "red_dark" }],
      members: [{ id: "member-1", fullName: "Ada Lovelace", username: "ada", email: "ada@example.com" }],
      customFields: [{
        id: "field-1",
        name: "Status",
        type: "list",
        options: [{ id: "option-1", value: { text: "Ready" }, color: "green" }],
      }],
      checklists: [{
        id: "checklist-1",
        name: "Prep",
        pos: 1,
        checkItems: [{ id: "item-1", name: "Review", pos: 1, state: "complete" }],
      }],
      cards: [{
        id: "card-1",
        name: "Write copy",
        desc: "Draft",
        idList: "list-todo",
        pos: 1,
        closed: false,
        due: "2026-01-01T09:00:00.000Z",
        dueComplete: false,
        idAttachmentCover: "attachment-2",
        idLabels: ["label-1"],
        idMembers: ["member-1"],
        idChecklists: ["checklist-1"],
        customFieldItems: [{ idCustomField: "field-1", idValue: "option-1" }],
        attachments: [
          { id: "attachment-1", name: "Spec", url: "https://example.com/spec", isUpload: false, mimeType: "text/plain", bytes: 12 },
          { id: "attachment-2", name: "Upload", url: "https://trello.com/file", isUpload: true, mimeType: "image/png", bytes: 24 },
        ],
      }],
      actions: [{
        id: "comment-1",
        type: "commentCard",
        idMemberCreator: "member-1",
        date: "2026-01-02T10:00:00.000Z",
        memberCreator: { fullName: "Ada Lovelace" },
        data: { text: "Looks good", card: { id: "card-1" } },
      }],
  });

  assert.equal(parsed.manifest.board.name, "Launch");
  assert.deepEqual(parsed.manifest.lists.map((list) => list.id), ["list-todo", "list-done"]);
  assert.equal(parsed.manifest.lists[0]?.cardCount, 1);
  assert.equal(parsed.manifest.labels[0]?.suggestedToken, "red");
  assert.equal(parsed.manifest.customFields[0]?.suggestedType, "select");
  assert.equal(parsed.manifest.members[0]?.email, "ada@example.com");
  assert.equal(parsed.manifest.counts.linkAttachments, 1);
  assert.equal(parsed.manifest.counts.uploadedAttachments, 1);
  assert.equal(parsed.source.comments[0]?.text, "Looks good");
  assert.equal(parsed.source.cards[0]?.customFieldItems[0]?.optionId, "option-1");
  assert.equal(parsed.source.cards[0]?.coverAttachmentId, "attachment-2");
});

void test("parseKaneraBoardExport accepts Kanera board archives and rejects other formats", () => {
  const parsed = parseKaneraBoardExport({
    format: "kanera.board.export",
    version: 1,
    exportedAt: "2026-06-10T00:00:00.000Z",
    board: {
      id: "00000000-0000-4000-8000-000000000001",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      name: "Launch",
      description: "Ship it",
      icon: "rocket",
      iconColor: "green",
    },
    lists: [{ id: "00000000-0000-4000-8000-000000000003", name: "Todo", position: "1000.0000000000" }],
    labels: [{ id: "00000000-0000-4000-8000-000000000004", name: "Important", color: "red" }],
    customFields: [{
      id: "00000000-0000-4000-8000-000000000005",
      name: "Status",
      icon: "forms",
      type: "select",
      allowMultiple: false,
      options: [{ id: "00000000-0000-4000-8000-000000000006", label: "Ready", color: "green", position: "1000.0000000000" }],
    }],
    members: [{
      workspaceId: "00000000-0000-4000-8000-000000000002",
      userId: "00000000-0000-4000-8000-000000000007",
      role: "admin",
      addedAt: "2026-06-10T00:00:00.000Z",
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      avatarUrl: null,
      source: "workspace",
      boardRole: "admin",
    }],
    cards: [{
      id: "00000000-0000-4000-8000-000000000008",
      listId: "00000000-0000-4000-8000-000000000003",
      boardId: "00000000-0000-4000-8000-000000000001",
      title: "Write copy",
      description: "Draft",
      position: "1000.0000000000",
      completedAt: null,
      archivedAt: null,
      createdById: "00000000-0000-4000-8000-000000000007",
    }],
    cardAssignees: [{ cardId: "00000000-0000-4000-8000-000000000008", userId: "00000000-0000-4000-8000-000000000007" }],
    cardLabelAssignments: [{ cardId: "00000000-0000-4000-8000-000000000008", labelId: "00000000-0000-4000-8000-000000000004" }],
    cardCustomFieldValues: [{ cardId: "00000000-0000-4000-8000-000000000008", fieldId: "00000000-0000-4000-8000-000000000005", valueOptionIds: ["00000000-0000-4000-8000-000000000006"] }],
    checklists: [{
      id: "00000000-0000-4000-8000-000000000009",
      cardId: "00000000-0000-4000-8000-000000000008",
      title: "Prep",
      position: "1000.0000000000",
      items: [{ id: "00000000-0000-4000-8000-000000000010", checklistId: "00000000-0000-4000-8000-000000000009", text: "Review", position: "1000.0000000000" }],
    }],
    comments: [{ id: "00000000-0000-4000-8000-000000000011", cardId: "00000000-0000-4000-8000-000000000008", authorId: "00000000-0000-4000-8000-000000000007", authorName: "Ada Lovelace", authorAvatarUrl: null, body: "Looks good" }],
    commentReactions: [{ commentId: "00000000-0000-4000-8000-000000000011", userId: "00000000-0000-4000-8000-000000000007", reactionType: "thumbs_up" }],
    cardWatchers: [{ cardId: "00000000-0000-4000-8000-000000000008", userId: "00000000-0000-4000-8000-000000000007" }],
    attachments: [{
      id: "00000000-0000-4000-8000-000000000012",
      cardId: "00000000-0000-4000-8000-000000000008",
      uploadedById: "00000000-0000-4000-8000-000000000007",
      fileName: "thread.eml",
      mimeType: "message/rfc822",
      byteSize: 256,
      url: "https://example.com/thread.eml",
      source: "attachment",
      commentId: null,
      createdAt: "2026-06-10T00:00:00.000Z",
    }],
  });

  assert.equal(parsed.manifest.source, "kanera");
  assert.equal(parsed.manifest.counts.cards, 1);
  assert.equal(parsed.manifest.counts.uploadedAttachments, 1);
  assert.equal(parsed.source.attachments[0]?.mimeType, "message/rfc822");
  assert.equal(parsed.manifest.members[0]?.email, "ada@example.com");
  assert.equal(parsed.manifest.customFields[0]?.options?.[0]?.color, "green");

  assert.throws(
    () => parseKaneraBoardExport({ format: "kanera.board.export", version: 2 }),
    ZodError,
  );
});
