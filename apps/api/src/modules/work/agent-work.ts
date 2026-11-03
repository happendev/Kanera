import { dto } from "@kanera/shared";
import type { AgentWorkHistoryQuery, AgentWorkHistoryResponse, AgentWorkQueryResponse, AgentWorkSources } from "@kanera/shared/dto";
import { cardLabels, lists, users } from "@kanera/shared/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { applyWorkScope, loadAccessibleBoards, type AccessibleBoard } from "../../lib/accessible-boards.js";
import { addDays, localDateInTimezone } from "../../lib/due-date.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { assertWorkDoneWindow, loadWorkDonePage } from "../../lib/work-done.js";
import { absoluteCardUrl } from "../../lib/wire-card.js";
import { visibleTeamUsers, workCards } from "./work-cards-query.js";

type AgentWorkCursor = {
  kind: "agentWorkHistory";
  signature: string;
  from: string;
  to: string;
  timeZone: string;
  at: string;
  id: string;
};

function encodeAgentWorkCursor(cursor: AgentWorkCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeAgentWorkCursor(raw: string | undefined): AgentWorkCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<AgentWorkCursor>;
    if (
      value.kind !== "agentWorkHistory"
      || typeof value.signature !== "string"
      || typeof value.from !== "string"
      || !Number.isFinite(new Date(value.from).getTime())
      || typeof value.to !== "string"
      || !Number.isFinite(new Date(value.to).getTime())
      || typeof value.timeZone !== "string"
      || typeof value.at !== "string"
      || !Number.isFinite(new Date(value.at).getTime())
      || typeof value.id !== "string"
    ) throw new Error();
    return value as AgentWorkCursor;
  } catch {
    throw badRequest("invalid work-history cursor");
  }
}

function isoWeekStart(localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number);
  const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  return addDays(localDate, -(weekday === 0 ? 6 : weekday - 1));
}

function monthStart(localDate: string, offset = 0): string {
  const [year, month] = localDate.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function presetLocalRange(preset: NonNullable<AgentWorkHistoryQuery["preset"]>, today: string): { from: string; to: string } {
  switch (preset) {
    case "today": return { from: today, to: addDays(today, 1) };
    case "yesterday": return { from: addDays(today, -1), to: today };
    case "this_week": {
      const from = isoWeekStart(today);
      return { from, to: addDays(from, 7) };
    }
    case "last_week": {
      const to = isoWeekStart(today);
      return { from: addDays(to, -7), to };
    }
    case "this_month": return { from: monthStart(today), to: monthStart(today, 1) };
    case "last_month": return { from: monthStart(today, -1), to: monthStart(today) };
  }
}

async function localRangeInstants(range: { from: string; to: string }, timeZone: string): Promise<{ from: Date; to: Date }> {
  const result = await db.execute<{ from: Date; to: Date }>(sql`
    select
      (${range.from}::date::timestamp at time zone ${timeZone}::text) as "from",
      (${range.to}::date::timestamp at time zone ${timeZone}::text) as "to"
  `);
  const row = result.rows[0];
  if (!row) throw badRequest("could not resolve work-history range");
  return { from: new Date(row.from), to: new Date(row.to) };
}

async function resolvedAgentWorkRange(auth: AuthClaims, query: AgentWorkHistoryQuery): Promise<{ from: Date; to: Date; timeZone: string }> {
  const [profile] = await db.select({ timeZone: users.timezone }).from(users).where(eq(users.id, auth.sub)).limit(1);
  const timeZone = query.timeZone ?? profile?.timeZone ?? "UTC";
  if (query.from && query.to) return { from: new Date(query.from), to: new Date(query.to), timeZone };
  const today = localDateInTimezone(new Date(), timeZone);
  const localRange = presetLocalRange(query.preset ?? "today", today);
  return { ...(await localRangeInstants(localRange, timeZone)), timeZone };
}

function cardWithUrl<T extends { organisationKey: string; key: string }>(card: T): T & { url: string } {
  return { ...card, url: absoluteCardUrl(card.organisationKey, card.key) };
}

function checklistAssignmentWithUrl<T extends { organisationKey: string; cardKey: string }>(item: T): T & { url: string } {
  return { ...item, url: absoluteCardUrl(item.organisationKey, item.cardKey) };
}

async function agentWorkSources(
  scopedBoards: AccessibleBoard[],
  cardsInResult: Array<{ boardId: string; listId: string; labelIds?: string[]; assigneeIds?: string[] }>,
): Promise<AgentWorkSources> {
  const boardIds = new Set(cardsInResult.map((card) => card.boardId));
  const listIds = new Set(cardsInResult.map((card) => card.listId));
  const labelIds = new Set(cardsInResult.flatMap((card) => card.labelIds ?? []));
  const peopleIds = new Set(cardsInResult.flatMap((card) => card.assigneeIds ?? []));
  const [listRows, labelRows, peopleRows] = await Promise.all([
    listIds.size ? db.select({ id: lists.id, workspaceId: lists.workspaceId, name: lists.name, inProgress: lists.inProgress }).from(lists).where(inArray(lists.id, [...listIds])) : [],
    labelIds.size ? db.select({ id: cardLabels.id, workspaceId: cardLabels.workspaceId, name: cardLabels.name, color: cardLabels.color }).from(cardLabels).where(inArray(cardLabels.id, [...labelIds])) : [],
    peopleIds.size ? db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, [...peopleIds])) : [],
  ]);
  return {
    boards: scopedBoards.filter((board) => boardIds.has(board.id)).map((board) => ({
      id: board.id,
      name: board.name,
      url: new URL(`/b/${board.id}`, env.WEB_ORIGIN).toString(),
      workspaceId: board.workspaceId,
      workspaceName: board.workspaceName,
      organisationId: board.clientId,
      organisationName: board.clientName,
    })),
    lists: listRows,
    labels: labelRows,
    people: peopleRows,
  };
}

export async function agentWorkHistory(auth: AuthClaims, input: unknown): Promise<AgentWorkHistoryResponse> {
  const query = dto.agentWorkHistoryQueryBody.parse(input ?? {});
  const cursor = decodeAgentWorkCursor(query.cursor);
  // Preset pages may cross local midnight while an agent is paging. Carry the first page's exact
  // boundaries in the opaque cursor so later pages continue the same report instead of failing or
  // silently switching to a new day.
  const range = cursor
    ? { from: new Date(cursor.from), to: new Date(cursor.to), timeZone: cursor.timeZone }
    : await resolvedAgentWorkRange(auth, query);
  assertWorkDoneWindow(range.from, range.to);
  const accessibleBoards = await loadAccessibleBoards(auth);
  const scopedBoards = applyWorkScope(accessibleBoards, query.scope);
  const actorUserId = query.userId ?? auth.sub;
  if (actorUserId !== auth.sub) {
    const visibleUserIds = await visibleTeamUsers(scopedBoards.map((board) => board.id), auth.sub);
    if (!visibleUserIds.includes(actorUserId)) throw forbidden("user is not visible in the selected work scope");
  }
  const [actor] = await db
    .select({ userId: users.id, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, actorUserId))
    .limit(1);
  if (!actor) throw notFound("user not found");
  const restrictedBoardIds = scopedBoards.filter((board) => board.assignedItemsOnly).map((board) => board.id);
  const signature = createHash("sha256").update(JSON.stringify({
    actorUserId,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    timeZone: range.timeZone,
    boardIds: scopedBoards.map((board) => board.id),
    q: query.q ?? null,
    requestedRange: query.from && query.to
      ? { from: query.from, to: query.to }
      : { preset: query.preset ?? "today" },
  })).digest("base64url");
  if (cursor && cursor.signature !== signature) throw badRequest("work-history cursor does not match this query");

  const result = await loadWorkDonePage({
    clientId: auth.cid,
    boardIds: scopedBoards.map((board) => board.id),
    from: range.from,
    to: range.to,
    q: query.q,
    timeZone: range.timeZone,
    actorUserId,
    visibilityUserId: auth.sub,
    visibilityRestrictedBoardIds: restrictedBoardIds,
  }, { limit: query.limit, cursor });
  const page = result.events;
  const hasMore = result.hasMore;
  const events = page.map((event) => ({ ...event, card: cardWithUrl(event.card) }));
  return {
    actor,
    range: { from: range.from.toISOString(), to: range.to.toISOString(), timeZone: range.timeZone },
    summary: result.summary,
    events,
    sources: await agentWorkSources(scopedBoards, events.map((event) => event.card)),
    nextCursor: hasMore
      ? encodeAgentWorkCursor({
          kind: "agentWorkHistory",
          signature,
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          timeZone: range.timeZone,
          at: page.at(-1)!.at,
          id: page.at(-1)!.id,
        })
      : null,
  };
}

export async function agentWorkCards(auth: AuthClaims, input: unknown): Promise<AgentWorkQueryResponse> {
  const accessibleBoards = await loadAccessibleBoards(auth);
  const query = dto.workCardsQueryBody.parse(input);
  const scopedBoards = applyWorkScope(accessibleBoards, query.scope);
  const result = await workCards(auth, accessibleBoards, query);
  const cards = result.cards.map(cardWithUrl);
  const checklistItems = result.checklistItems.map(checklistAssignmentWithUrl);
  const sourceCards = [
    ...cards,
    ...checklistItems.map((item) => ({
      boardId: item.boardId,
      listId: item.listId,
      assigneeIds: [item.assigneeId],
    })),
  ];
  return {
    ...result,
    cards,
    checklistItems,
    sources: await agentWorkSources(scopedBoards, sourceCards),
  };
}
