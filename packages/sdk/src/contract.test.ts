import assert from "node:assert/strict";
import test from "node:test";
import type { z } from "zod";
import type {
  bulkArchiveCardsBody, bulkPatchCardAssigneesBody, bulkPatchCardLabelsBody,
  bulkSetCardCustomFieldBody, createCardBody, createChecklistBody, createChecklistItemBody,
  moveCardBody, setCustomFieldValueBody, updateCardBody, updateChecklistItemBody,
} from "@kanera/shared/dto";
import type { createCardPriorityBody, moveCardPriorityBody } from "@kanera/shared/dto";
import type { createCommentBody } from "@kanera/shared/dto";
import type { createNoteBody, updateNoteBody } from "@kanera/shared/dto";
import type { agentSearchQueryBody } from "@kanera/shared/dto";
import type { workFiltersSchema, workScopeSchema } from "@kanera/shared/dto";
import type { createBoardBody, createWorkspaceBody } from "@kanera/shared/dto";
import type { WorkspaceTemplateId as SharedWorkspaceTemplateId } from "@kanera/shared/workspace-templates";
import type {
  CreateCardInput, CreateChecklistItemInput, CustomFieldValueInput, UpdateCardInput, UpdateChecklistItemInput,
} from "./resources/cards.js";
import type { CreateNoteInput, UpdateNoteInput } from "./resources/notes.js";
import type { SearchInput } from "./resources/search.js";
import type { CreateBoardInput, CreateWorkspaceInput, WorkFilters, WorkScope, WorkspaceTemplateId } from "./types.js";

/**
 * Compile-time drift guard.
 *
 * The SDK is deliberately self-contained — it must publish with no workspace dependency — so its
 * input types are hand-written copies of shapes the API validates with Zod. This file imports the
 * real schemas as a devDependency, type-only, and asserts each SDK input is still something the API
 * would accept. Renaming or tightening a field in packages/shared breaks `pnpm lint` here rather
 * than breaking an integrator at runtime.
 *
 * The comparison is against `z.input`, not `z.infer`: defaults are applied during parsing, so the
 * post-parse type marks fields required that a caller may legitimately omit.
 */
type Extends<Actual extends Expected, Expected> = Actual;
type AssertAssignable<Actual extends Expected, Expected> = Extends<Actual, Expected>;

// Workspace and board bootstrap. Seed content is name-referenced; both directions of the template
// id union are asserted so adding a template in packages/shared shows up here.
type _CreateWorkspace = AssertAssignable<CreateWorkspaceInput, z.input<typeof createWorkspaceBody>>;
type _CreateBoard = AssertAssignable<CreateBoardInput, z.input<typeof createBoardBody>>;
type _TemplateIdForward = AssertAssignable<WorkspaceTemplateId, SharedWorkspaceTemplateId>;
type _TemplateIdBackward = AssertAssignable<SharedWorkspaceTemplateId, WorkspaceTemplateId>;

// Cards.
type _CreateCard = AssertAssignable<CreateCardInput, z.input<typeof createCardBody>>;
type _UpdateCard = AssertAssignable<UpdateCardInput, z.input<typeof updateCardBody>>;
// move() translates its PositionAnchor into the anchor fields the API expects.
type _MoveCard = AssertAssignable<{ listId: string; beforeCardId: string | null }, z.input<typeof moveCardBody>>;

// Checklists. The item label is `text`; a live run against the API is what caught `title` here.
type _CreateChecklist = AssertAssignable<{ title: string; parentItemId?: string | null }, z.input<typeof createChecklistBody>>;
type _CreateItem = AssertAssignable<CreateChecklistItemInput, z.input<typeof createChecklistItemBody>>;
type _UpdateItem = AssertAssignable<UpdateChecklistItemInput, z.input<typeof updateChecklistItemBody>>;

// Bulk mutations and priority anchors. Both were wrong on the first live run — the bulk endpoints
// take a `mode` plus one id list, and priority anchors are bare `afterId`/`beforeId`.
type _BulkLabels = AssertAssignable<
  { cardIds: string[]; mode: "add" | "remove"; labelIds: string[] },
  z.input<typeof bulkPatchCardLabelsBody>
>;
type _BulkAssignees = AssertAssignable<
  { cardIds: string[]; mode: "add" | "remove"; userIds: string[] },
  z.input<typeof bulkPatchCardAssigneesBody>
>;
type _BulkArchive = AssertAssignable<{ cardIds: string[]; archived: true }, z.input<typeof bulkArchiveCardsBody>>;
// Custom field values are column-shaped (`{ valueText }`), never bare values; both the single-card
// PUT and the bulk endpoint take the same columns.
type _CustomFieldValue = AssertAssignable<CustomFieldValueInput, z.input<typeof setCustomFieldValueBody>>;
type _BulkCustomField = AssertAssignable<
  { cardIds: string[]; fieldId: string; mode: "setAll" | "fillEmpty" | "add" | "remove" | "clear" } & CustomFieldValueInput,
  z.input<typeof bulkSetCardCustomFieldBody>
>;
type _CreatePriority = AssertAssignable<{ cardId: string; beforeId: string | null }, z.input<typeof createCardPriorityBody>>;
type _MovePriority = AssertAssignable<{ afterId: string | null }, z.input<typeof moveCardPriorityBody>>;

// Comments.
type _CreateComment = AssertAssignable<{ body: string; attachmentIds?: string[] }, z.input<typeof createCommentBody>>;

// Notes. create() supplies the `scope` default before sending, which is why the SDK input may omit it.
type _CreateNote = AssertAssignable<CreateNoteInput & { scope: "personal" | "team" }, z.input<typeof createNoteBody>>;
type _UpdateNote = AssertAssignable<UpdateNoteInput, z.input<typeof updateNoteBody>>;

// Search and work.
type _Search = AssertAssignable<SearchInput, z.input<typeof agentSearchQueryBody>>;
type _WorkScope = AssertAssignable<WorkScope, z.input<typeof workScopeSchema>>;
type _WorkFilters = AssertAssignable<WorkFilters, z.input<typeof workFiltersSchema>>;

void test("SDK input types still match the schemas the API validates with", () => {
  // The assertions above are type-level; this keeps the file a real test so a broken import is
  // reported by the runner as well as by tsc.
  assert.ok(true);
});
