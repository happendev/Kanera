import type { WorkDoneEvent, WorkDoneEventType } from "@kanera/shared/dto";
import { dayFullLabel, dayGroupLabel, localDateKey } from "../../../shared/day-key.util";
import type {
  CardDayDigest,
  WorkDoneActor,
  WorkDoneChecklistTick,
  WorkDoneDay,
  WorkDoneListStep,
} from "./work-done.types";

/** Max list names shown in a move path before the middle collapses to an ellipsis. */
export const MOVE_PATH_MAX = 4;

/** Resolved list metadata, keyed by list id, used to render move paths. */
export type ListLookup = ReadonlyMap<string, { name: string; icon: string | null; color: string | null }>;

/**
 * Ranked worst-to-best by how much the row wants to lead with it. Completion is the outcome a daily
 * report is actually about, so it wins even if the card was also moved later that day; a bare "moved"
 * only leads when nothing more meaningful happened.
 */
const LEAD_PRECEDENCE: WorkDoneEventType[] = ["created", "moved", "checklistItemCompleted", "completed"];

/** Actor display branches on type: checklist completions carry their own completedBy fields. */
export function actorNameFor(event: WorkDoneEvent): string {
  return event.type === "checklistItemCompleted" ? event.completedByName : event.actorName;
}

export function actorAvatarFor(event: WorkDoneEvent): string | null {
  return event.type === "checklistItemCompleted" ? event.completedByAvatarUrl : event.actorAvatarUrl;
}

export function actorUserIdFor(event: WorkDoneEvent): string | null {
  return event.type === "checklistItemCompleted" ? event.completedByUserId : event.actorUserId;
}

/** Tabler icon name for each event type. */
export function iconForType(type: WorkDoneEventType): string {
  switch (type) {
    case "created": return "plus";
    case "moved": return "arrow-right";
    case "completed": return "circle-check";
    case "checklistItemCompleted": return "checkbox";
  }
}

/** Short verb describing an event type. */
export function verbForType(type: WorkDoneEventType): string {
  switch (type) {
    case "created": return "Created";
    case "moved": return "Moved";
    case "completed": return "Completed";
    case "checklistItemCompleted": return "Checked off";
  }
}

/**
 * Collapses a resolved list journey so the row stays compact: a path of 5+ lists renders as
 * "first → second → third → … → last".
 */
export function collapseListPath(steps: WorkDoneListStep[]): WorkDoneListStep[] {
  if (steps.length <= MOVE_PATH_MAX) return steps;
  return [
    ...steps.slice(0, MOVE_PATH_MAX - 1),
    { text: "…", icon: null, color: null, ellipsis: true },
    steps[steps.length - 1]!,
  ];
}

/** Accumulates distinct people and how many events each accounts for, busiest first. */
function collectActors(events: readonly WorkDoneEvent[]): WorkDoneActor[] {
  const byKey = new Map<string, WorkDoneActor>();
  for (const event of events) {
    const userId = actorUserIdFor(event);
    const name = actorNameFor(event);
    const key = actorKeyFor(event);
    const existing = byKey.get(key);
    if (existing) {
      existing.eventCount += 1;
      continue;
    }
    byKey.set(key, { userId, name, avatarUrl: actorAvatarFor(event), eventCount: 1 });
  }
  return [...byKey.values()].sort((a, b) => b.eventCount - a.eventCount || a.name.localeCompare(b.name));
}

/**
 * Stable identity for an actor. System and API-key activity has no user id, so the display name
 * stands in — otherwise every non-user actor would merge into one anonymous row.
 */
function actorKeyFor(event: WorkDoneEvent): string {
  return actorUserIdFor(event) ?? `name:${actorNameFor(event)}`;
}

/**
 * Merges one person's events on one card for a single day into a digest row.
 *
 * The move path concatenates every move that day, in chronological order, dropping a step that
 * repeats the previous one — the server already coalesces consecutive moves per day, but a card
 * whose run was broken by a completion yields two move events whose ends meet.
 */
function buildDigest(dateKey: string, actorKey: string, events: WorkDoneEvent[], lists: ListLookup): CardDayDigest {
  const ordered = [...events].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const latest = ordered[ordered.length - 1]!;

  const listIds: string[] = [];
  const checklistTicks: WorkDoneChecklistTick[] = [];
  let created = false;
  let completed = false;

  for (const event of ordered) {
    switch (event.type) {
      case "created":
        created = true;
        break;
      case "completed":
        completed = true;
        break;
      case "moved":
        for (const listId of event.listPath) {
          if (listIds[listIds.length - 1] !== listId) listIds.push(listId);
        }
        break;
      case "checklistItemCompleted":
        checklistTicks.push({
          itemId: event.itemId,
          text: event.text,
          checklistTitle: event.checklistTitle,
          at: event.at,
        });
        break;
    }
  }

  const steps = listIds
    .map((id) => lists.get(id))
    .filter((list): list is NonNullable<typeof list> => Boolean(list))
    .map((list) => ({ text: list.name, icon: list.icon, color: list.color, ellipsis: false }));

  let leadType = ordered[0]!.type;
  for (const event of ordered) {
    if (LEAD_PRECEDENCE.indexOf(event.type) > LEAD_PRECEDENCE.indexOf(leadType)) leadType = event.type;
  }

  return {
    key: `${dateKey}:${latest.card.id}:${actorKey}`,
    cardId: latest.card.id,
    // The latest event carries the freshest card summary, so the row's title and chips match the
    // card as it stands at the end of that day.
    card: latest.card,
    boardId: latest.boardId,
    lastAt: latest.at,
    eventCount: ordered.length,
    created,
    completed,
    listPath: collapseListPath(steps),
    checklistTicks,
    actors: collectActors(ordered),
    leadType,
  };
}

/**
 * Groups a flat event stream into local days, newest day first, each day's cards newest first.
 *
 * Bucketing happens on the viewer's local calendar day, matching the `timeZone` sent to the server,
 * so an evening event stays on the day the viewer experienced it.
 */
export function groupIntoDays(
  events: readonly WorkDoneEvent[],
  lists: ListLookup,
  today: Date = new Date(),
): WorkDoneDay[] {
  const byDay = new Map<string, WorkDoneEvent[]>();
  for (const event of events) {
    const dateKey = localDateKey(new Date(event.at));
    const bucket = byDay.get(dateKey);
    if (bucket) bucket.push(event);
    else byDay.set(dateKey, [event]);
  }

  const days: WorkDoneDay[] = [];
  for (const [dateKey, dayEvents] of byDay) {
    // Keyed by card *and* person: two people who both touched a card on the same day did two separate
    // pieces of work, and a row that merged them could not honestly name who did what.
    const byCardAndActor = new Map<string, { actorKey: string; events: WorkDoneEvent[] }>();
    for (const event of dayEvents) {
      const actorKey = actorKeyFor(event);
      const key = `${event.card.id}|${actorKey}`;
      const bucket = byCardAndActor.get(key);
      if (bucket) bucket.events.push(event);
      else byCardAndActor.set(key, { actorKey, events: [event] });
    }

    const counts: Record<WorkDoneEventType, number> = {
      created: 0,
      moved: 0,
      completed: 0,
      checklistItemCompleted: 0,
    };
    for (const event of dayEvents) counts[event.type] += 1;

    days.push({
      dateKey,
      label: dayGroupLabel(dateKey, today),
      fullLabel: dayFullLabel(dateKey),
      digests: [...byCardAndActor.values()]
        .map((bucket) => buildDigest(dateKey, bucket.actorKey, bucket.events, lists))
        .sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime()),
      eventCount: dayEvents.length,
      counts,
      actors: collectActors(dayEvents),
    });
  }

  return days.sort((a, b) => b.dateKey.localeCompare(a.dateKey));
}

/** Per-day counts for one metric, keyed by local day, for the activity strip. */
export function countsByDay(days: readonly WorkDoneDay[], metric: WorkDoneEventType): Map<string, number> {
  return new Map(days.map((day) => [day.dateKey, day.counts[metric]]));
}

/**
 * Plain-text standup summary for a day, grouped by outcome rather than by time.
 *
 * Reading order is what someone actually reports in a standup: what shipped, what progressed, what
 * started, then checklist detail.
 */
export function buildStandupText(day: WorkDoneDay, boardNames?: ReadonlyMap<string, string>): string {
  const lines: string[] = [`Work done — ${day.fullLabel}`];

  const label = (digest: CardDayDigest) => {
    const board = boardNames?.get(digest.boardId);
    const who = digest.actors.map((actor) => actor.name).join(", ");
    const suffix = [board, who].filter(Boolean).join(" · ");
    return suffix ? `${digest.card.title} (${suffix})` : digest.card.title;
  };

  const section = (heading: string, digests: CardDayDigest[], detail?: (digest: CardDayDigest) => string) => {
    if (digests.length === 0) return;
    lines.push("", heading);
    for (const digest of digests) {
      const extra = detail?.(digest);
      lines.push(`- ${label(digest)}${extra ? ` — ${extra}` : ""}`);
    }
  };

  const completed = day.digests.filter((digest) => digest.completed);
  // A card that shipped is reported under Completed only, so it is never listed twice.
  const moved = day.digests.filter((digest) => !digest.completed && digest.listPath.length > 1);
  const created = day.digests.filter((digest) => !digest.completed && digest.created && digest.listPath.length <= 1);
  const checklist = day.digests.filter((digest) => digest.checklistTicks.length > 0);

  section("Completed", completed);
  section("Moved", moved, (digest) => digest.listPath.map((step) => step.text).join(" → "));
  section("Created", created);
  section("Checklist", checklist, (digest) =>
    digest.checklistTicks.length === 1
      ? digest.checklistTicks[0]!.text
      : `${digest.checklistTicks.length} items`);

  if (lines.length === 1) lines.push("", "No work recorded.");
  return lines.join("\n");
}

/** Standup text for a whole range, days newest first. */
export function buildRangeStandupText(
  days: readonly WorkDoneDay[],
  boardNames?: ReadonlyMap<string, string>,
): string {
  if (days.length === 0) return "No work recorded.";
  return days.map((day) => buildStandupText(day, boardNames)).join("\n\n");
}
