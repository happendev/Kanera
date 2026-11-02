import { dto } from "@kanera/shared";
import type { AuthClaims } from "../../auth/plugin.js";
import { applyWorkScope, loadAccessibleBoards } from "../../lib/accessible-boards.js";
import { assertWorkDoneWindow, loadWorkDone, type LoadWorkDoneOptions } from "../../lib/work-done.js";
import { visibleTeamUsers } from "./work-cards-query.js";

/**
 * Lens, scope and the card-level access boundary for the global work-done surfaces.
 *
 * Shared by the timeline and its activity strip: the strip must narrow with exactly the same
 * lens and visibility rules, or its counts would describe a different set of cards than the rows
 * beneath it — and for a restricted viewer could disclose the volume of hidden work.
 */
export async function globalWorkDoneOptions(
  auth: AuthClaims,
  query: dto.GlobalWorkDoneQuery | dto.GlobalWorkDoneSummaryQuery,
): Promise<{ options: LoadWorkDoneOptions; filters: dto.WorkFilters; accessibleCount: number; scopedCount: number }> {
  const from = new Date(query.from);
  const to = new Date(query.to);
  assertWorkDoneWindow(from, to);

  const accessibleBoards = await loadAccessibleBoards(auth);
  const scopeBoards = applyWorkScope(accessibleBoards, query.scope);
  const boardIds = scopeBoards.map((board) => board.id);
  const filters = dto.workFiltersSchema.parse(query.filters ?? {});
  const visibleTeammateIds = query.lens === "team"
    ? await visibleTeamUsers(boardIds, auth.sub)
    : [];
  const actorUserIds = filters.assigneeIds.length
    ? filters.assigneeIds.filter((id) => visibleTeammateIds.includes(id))
    : visibleTeammateIds;
  const restrictedBoardIds = scopeBoards
    .filter((board) => board.assignedItemsOnly)
    .map((board) => board.id);

  return {
    options: {
      clientId: auth.cid,
      boardIds,
      from,
      to,
      q: filters.q || undefined,
      timeZone: query.timeZone,
      // Applied in SQL so the activity strip narrows with the timeline. The timeline additionally
      // re-applies these in JS below, which is redundant but harmless.
      listIds: filters.listIds,
      labelIds: filters.labelIds,
      ...(query.lens === "my"
        ? { actorUserId: auth.sub }
        : { actorUserIds }),
      // The overview's "Recently done" reads this: a card a "move to Done" automation closed is
      // still its assignees' delivery, and otherwise it would vanish from every person's panel.
      automatedCompletionsForAssignees: true,
      // Historical activity must obey the same card-level boundary as the live global views.
      visibilityUserId: auth.sub,
      visibilityRestrictedBoardIds: restrictedBoardIds,
    },
    filters,
    accessibleCount: accessibleBoards.length,
    scopedCount: scopeBoards.length,
  };
}

/** `POST /work/work-done/query`: the global work-done timeline plus the figures its log reports. */
export async function queryGlobalWorkDone({
  auth,
  query,
}: {
  auth: AuthClaims;
  query: dto.GlobalWorkDoneQuery;
}): Promise<{ events: Awaited<ReturnType<typeof loadWorkDone>>["events"]; boardCount: number; accessibleCount: number; scopedCount: number }> {
  const { options, filters, accessibleCount, scopedCount } = await globalWorkDoneOptions(auth, query);
  const boardIds = options.boardIds;

  const result = await loadWorkDone(options);
  const listIds = new Set(filters.listIds);
  const labelIds = new Set(filters.labelIds);
  const events = result.events.filter((event) =>
    (listIds.size === 0 || listIds.has(event.card.listId))
    && (labelIds.size === 0 || event.card.labelIds.some((id) => labelIds.has(id)))
  );

  return { events, boardCount: boardIds.length, accessibleCount, scopedCount };
}
