import type { GettingStartedStep, GettingStartedUsedStep, HomeGettingStartedResponse } from "@kanera/shared/dto";
import { GETTING_STARTED_STEPS } from "@kanera/shared/dto";
import {
  activityEvents,
  automations,
  boardInvitations,
  boards,
  cardAssignees,
  cardMentions,
  cardRelations,
  cards,
  clientMembers,
  comments,
  inviteTokens,
  notes,
  notificationSettings,
  oauthGrants,
  pushSubscriptions,
  scratchpadNotes,
  users,
  workspaceApiKeys,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { and, asc, eq, gt, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { isClientAdminRole } from "../../lib/client-membership.js";
import { getWebPushPublicConfig } from "../../lib/web-push.js";

/** Account age after which the checklist no longer shows. */
const GETTING_STARTED_MAX_AGE_DAYS = 35;

/** The steps that only an organisation admin can act on: inviting, adding boards, automations. */
const ADMIN_STEPS: ReadonlySet<GettingStartedStep> = new Set(["inviteTeam", "secondBoard", "createAutomation"]);

/**
 * Derives the home checklist from the rows each step creates, so a step ticks itself off however
 * it was done (web, CLI, MCP, another device) and nothing can drift out of sync.
 *
 * The basics and the "work faster" and notes steps are per user: they teach each person the core
 * loop, so a teammate's cards do not tick them off. Steps that leave no row behind (palette, filter,
 * Work done, quick edit) are stamped by the web on first use, in `user.getting_started_used`. Team steps (invite, second board, automation) are
 * organisation-wide on purpose: an admin who joins an organisation that already has a team, boards
 * and automations has nothing to do there, and the automation table records no creator to narrow it
 * by. Agent and push steps are per user, because each person connects their own agent and devices.
 */
export async function loadGettingStarted(auth: AuthClaims): Promise<HomeGettingStartedResponse> {
  const [user] = await db
    .select({
      hiddenAt: users.gettingStartedHiddenAt,
      dismissedAt: users.gettingStartedDismissedAt,
      used: users.gettingStartedUsed,
      showScratchpad: users.showScratchpad,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, auth.sub))
    .limit(1);
  // Closed is closed: skip every other read rather than computing steps nobody will see.
  // Someone who has used Kanera for over GETTING_STARTED_MAX_AGE_DAYS has found their way around;
  // the checklist retires itself for them as if closed, on home and in the account menu alike.
  const retired = user ? Date.now() - user.createdAt.getTime() > GETTING_STARTED_MAX_AGE_DAYS * 86_400_000 : false;
  if (!user || user.dismissedAt || retired) return { dismissed: true, hidden: false, steps: [], teamTarget: null, notesWorkspaceId: null };

  const admin = isClientAdminRole(auth.role);
  const none = Promise.resolve(false);
  const [
    createCard, assignCard, comment, mention, addDependency, completeCard, scratchpad, savedNote,
    inviteTeam, secondBoard, createAutomation, connectAgent, useAgent, push, teamTarget, notesWorkspaceId,
  ] = await Promise.all([
    hasActivity(auth, "card", eq(activityEvents.action, "created")),
    hasAssignedCard(auth),
    hasActivity(auth, "comment", eq(activityEvents.action, "created")),
    hasMentioned(auth),
    hasAddedDependency(auth),
    hasCompletedCard(auth),
    user.showScratchpad ? hasUsedScratchpad(auth) : none,
    hasSavedNote(auth),
    admin ? hasInvitedTeam(auth) : none,
    admin ? hasSecondBoard(auth.cid) : none,
    admin ? hasAutomation(auth.cid) : none,
    hasConnectedAgent(auth),
    hasAgentWork(auth),
    loadPushStep(auth),
    admin ? loadTeamTarget(auth.cid) : Promise.resolve(null),
    loadNotesWorkspace(auth),
  ]);

  const used = (key: GettingStartedUsedStep) => Boolean(user.used[key]);
  const done: Record<GettingStartedStep, boolean> = {
    createCard,
    assignCard,
    comment,
    mention,
    addDependency,
    completeCard,
    quickEdit: used("quickEdit"),
    useFilter: used("useFilter"),
    commandPalette: used("commandPalette"),
    viewWorkDone: used("viewWorkDone"),
    scratchpad,
    saveNote: savedNote,
    inviteTeam,
    secondBoard,
    createAutomation,
    enablePush: push.done,
    // An agent that has made changes was connected, even if its grant or key is gone since.
    connectAgent: connectAgent || useAgent,
    useAgent,
  };
  // A step the viewer cannot take is left out rather than shown undone: admin steps for members,
  // push where it cannot be delivered, the scratchpad when it is switched off in Preferences, and
  // notes when no workspace they can open has notes switched on. A note already saved still counts.
  const available: Partial<Record<GettingStartedStep, boolean>> = {
    enablePush: push.available,
    scratchpad: user.showScratchpad,
    saveNote: notesWorkspaceId !== null || savedNote,
  };
  const steps = GETTING_STARTED_STEPS
    .filter((key) => (admin || !ADMIN_STEPS.has(key)) && available[key] !== false)
    .map((key) => ({ key, done: done[key] }));
  // Hidden still computes the steps: the account menu shows the same progress as home did.
  return { dismissed: false, hidden: user.hiddenAt !== null, steps, teamTarget, notesWorkspaceId };
}

/** The one-way stamps keep their first timestamp on a repeated call; hidden is a plain toggle. */
export async function updateGettingStarted(
  userId: string,
  body: { dismissed?: true; hidden?: boolean; used?: GettingStartedUsedStep },
): Promise<void> {
  const set: { gettingStartedHiddenAt?: SQL | null; gettingStartedDismissedAt?: SQL; gettingStartedUsed?: SQL } = {};
  if (body.hidden !== undefined) set.gettingStartedHiddenAt = body.hidden ? sql`coalesce(${users.gettingStartedHiddenAt}, now())` : null;
  if (body.dismissed) set.gettingStartedDismissedAt = sql`coalesce(${users.gettingStartedDismissedAt}, now())`;
  if (body.used) {
    // jsonb `||` keeps the right-hand value, so re-reading the existing stamp keeps the first one.
    set.gettingStartedUsed = sql`${users.gettingStartedUsed} || jsonb_build_object(${body.used}::text, coalesce(${users.gettingStartedUsed}->${body.used}::text, to_jsonb(now())))`;
  }
  if (Object.keys(set).length === 0) return;
  await db.update(users).set(set).where(eq(users.id, userId));
}

/**
 * The oldest workspace with notes switched on that the viewer can open (admins can open every
 * workspace; members through their workspace membership). Where the notes step sends people.
 */
async function loadNotesWorkspace(auth: AuthClaims): Promise<string | null> {
  const member = isClientAdminRole(auth.role)
    ? undefined
    : sql`exists (select 1 from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${workspaces.id} and ${workspaceMembers.userId} = ${auth.sub})`;
  const [row] = await db.select({ id: workspaces.id })
    .from(workspaces)
    .where(and(
      eq(workspaces.clientId, auth.cid),
      isNull(workspaces.archivedAt),
      eq(workspaces.notesEnabled, true),
      ne(workspaces.kind, "board"),
      member,
    ))
    .orderBy(asc(workspaces.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** Standard workspaces sort first; within a kind, the oldest is the one the team set up first. */
async function loadTeamTarget(clientId: string): Promise<HomeGettingStartedResponse["teamTarget"]> {
  const [row] = await db
    .select({ workspaceId: workspaces.id, kind: workspaces.kind, boardId: boards.id })
    .from(workspaces)
    .leftJoin(boards, and(eq(boards.workspaceId, workspaces.id), isNull(boards.archivedAt)))
    .where(and(eq(workspaces.clientId, clientId), isNull(workspaces.archivedAt)))
    .orderBy(sql`${workspaces.kind} = 'board'`, asc(workspaces.createdAt), asc(boards.createdAt))
    .limit(1);
  if (!row) return null;
  if (row.kind !== "board") return { workspaceId: row.workspaceId };
  return row.boardId ? { boardId: row.boardId } : null;
}

async function exists(query: Promise<unknown[]>): Promise<boolean> {
  return (await query).length > 0;
}

/**
 * Card, assignment, comment and completion steps read the activity log, because the rows themselves
 * cannot answer "did this person do it": cards have no creator index, assignments record no actor,
 * and comments are copied with their original author when a card is duplicated or mirrored. The log
 * is kept for ACTIVITY_EVENT_RETENTION_DAYS (two years by default), and these filters lead with the
 * (workspace_id, actor_id, …) columns of activity_events_coalesce_probe_idx. Automations log with
 * no actor, so they never tick a person's step.
 *
 * Template starter cards are written in the workspace's creation transaction and share its exact
 * created_at (see hasAutomation), so `created_at > workspace.created_at` keeps a new account from
 * starting with "Create your first card" already ticked.
 */
function hasActivity(auth: AuthClaims, entityType: "card" | "comment", condition: SQL | undefined): Promise<boolean> {
  return exists(db.select({ id: activityEvents.id })
    .from(activityEvents)
    .innerJoin(workspaces, eq(workspaces.id, activityEvents.workspaceId))
    .where(and(
      eq(workspaces.clientId, auth.cid),
      eq(activityEvents.actorId, auth.sub),
      eq(activityEvents.entityType, entityType),
      gt(activityEvents.createdAt, workspaces.createdAt),
      condition,
    ))
    .limit(1));
}

/**
 * The same predicate Work done uses for a completion (lib/work-done.ts): app routes log a coalesced
 * `completion:set`, older and non-coalesced writers a plain `completed`.
 */
function hasCompletedCard(auth: AuthClaims): Promise<boolean> {
  return hasActivity(auth, "card", or(
    eq(activityEvents.action, "completed"),
    and(eq(activityEvents.action, "completion:set"), sql`${activityEvents.payload}->>'toValue' = 'true'`),
  ));
}

/**
 * A mention in a comment this person wrote. Mentions record no writer of their own; the comment's
 * author is it. Description mentions are left out because nothing records who typed them.
 */
function hasMentioned(auth: AuthClaims): Promise<boolean> {
  return exists(db.select({ id: cardMentions.userId })
    .from(cardMentions)
    .innerJoin(comments, eq(comments.id, cardMentions.commentId))
    .innerJoin(cards, eq(cards.id, comments.cardId))
    .innerJoin(workspaces, eq(workspaces.id, cards.workspaceId))
    .where(and(
      eq(comments.authorId, auth.sub),
      eq(comments.authorKind, "user"),
      eq(workspaces.clientId, auth.cid),
    ))
    .limit(1));
}

/** Opening the panel or adding a blank page saves an empty row; only words on a page count. */
function hasUsedScratchpad(auth: AuthClaims): Promise<boolean> {
  return exists(db.select({ id: scratchpadNotes.id })
    .from(scratchpadNotes)
    .where(and(
      eq(scratchpadNotes.userId, auth.sub),
      eq(scratchpadNotes.clientId, auth.cid),
      or(ne(scratchpadNotes.content, ""), ne(scratchpadNotes.title, "")),
    ))
    .limit(1));
}

/** New notes are inserted blank the moment they are created; a title or body makes one saved. */
function hasSavedNote(auth: AuthClaims): Promise<boolean> {
  return exists(db.select({ id: notes.id })
    .from(notes)
    .innerJoin(workspaces, eq(workspaces.id, notes.workspaceId))
    .where(and(
      eq(notes.ownerId, auth.sub),
      eq(workspaces.clientId, auth.cid),
      or(ne(notes.content, ""), ne(notes.title, "")),
    ))
    .limit(1));
}

/**
 * Yourself counts: a team of one still learns what an owner is for. Two ways in: an assignee change
 * that left someone assigned, or a card this person created with assignees already set in the
 * composer, which is logged as the card's creation rather than as an assignee change.
 */
function hasAssignedCard(auth: AuthClaims): Promise<boolean> {
  return hasActivity(auth, "card", or(
    and(
      eq(activityEvents.action, "assignees:set"),
      sql`jsonb_array_length(coalesce(${activityEvents.payload}->'assigneeIds', '[]'::jsonb)) > 0`,
    ),
    and(
      eq(activityEvents.action, "created"),
      sql`exists (select 1 from ${cardAssignees} where ${cardAssignees.cardId} = ${activityEvents.entityId})`,
    ),
  ));
}

/** Relations carry their creator, and every kind (blocked by, blocking, related) teaches the same. */
function hasAddedDependency(auth: AuthClaims): Promise<boolean> {
  return exists(db.select({ id: cardRelations.id })
    .from(cardRelations)
    .innerJoin(workspaces, eq(workspaces.id, cardRelations.workspaceId))
    .where(and(eq(workspaces.clientId, auth.cid), eq(cardRelations.createdById, auth.sub)))
    .limit(1));
}

/**
 * Someone else is in the organisation, or an invitation went out. A live invite counts on its own:
 * the step is "invite", and the person may not have accepted yet. Guest board invitations count
 * too, since bringing a client onto a board is how some teams start.
 */
async function hasInvitedTeam(auth: AuthClaims): Promise<boolean> {
  const [otherMember, invite, guestInvite] = await Promise.all([
    exists(db.select({ id: clientMembers.userId }).from(clientMembers).where(and(
      eq(clientMembers.clientId, auth.cid),
      ne(clientMembers.userId, auth.sub),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
    )).limit(1)),
    exists(db.select({ id: inviteTokens.id }).from(inviteTokens).where(and(
      eq(inviteTokens.clientId, auth.cid),
      isNull(inviteTokens.revokedAt),
    )).limit(1)),
    exists(db.select({ id: boardInvitations.id }).from(boardInvitations).where(and(
      eq(boardInvitations.clientId, auth.cid),
      isNull(boardInvitations.revokedAt),
    )).limit(1)),
  ]);
  return otherMember || invite || guestInvite;
}

/** Workspace and standalone boards alike; both are a second place to work. */
async function hasSecondBoard(clientId: string): Promise<boolean> {
  const rows = await db.select({ id: boards.id })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(and(eq(workspaces.clientId, clientId), isNull(workspaces.archivedAt), isNull(boards.archivedAt)))
    .limit(2);
  return rows.length >= 2;
}

/**
 * An automation someone built, not one a template seeded. Template recipes are inserted in the
 * transaction that creates the workspace (POST /workspaces), and Postgres stamps every row in one
 * transaction with the same now(), so seeded automations share the workspace's exact created_at.
 * Without this, every new account would start with the step already ticked. Disabled automations
 * still count: the step teaches building one, not leaving it switched on.
 */
function hasAutomation(clientId: string): Promise<boolean> {
  return exists(db.select({ id: automations.id })
    .from(automations)
    .innerJoin(workspaces, eq(workspaces.id, automations.workspaceId))
    .where(and(
      eq(workspaces.clientId, clientId),
      isNull(workspaces.archivedAt),
      isNull(automations.archivedAt),
      gt(automations.createdAt, workspaces.createdAt),
    ))
    .limit(1));
}

/**
 * An interactive agent connection (MCP or CLI sign-in) or an API key this user created in this
 * organisation. Creation is enough; requiring a first call would leave the step open for someone
 * who set the key up and has not run the agent yet, with nothing left to do on the web.
 */
async function hasConnectedAgent(auth: AuthClaims): Promise<boolean> {
  const [grant, key] = await Promise.all([
    exists(db.select({ id: oauthGrants.id }).from(oauthGrants).where(and(
      eq(oauthGrants.userId, auth.sub),
      eq(oauthGrants.orgClientId, auth.cid),
      isNull(oauthGrants.revokedAt),
    )).limit(1)),
    exists(db.select({ id: workspaceApiKeys.id })
      .from(workspaceApiKeys)
      .leftJoin(workspaces, eq(workspaces.id, workspaceApiKeys.workspaceId))
      .where(and(
        eq(workspaceApiKeys.createdById, auth.sub),
        isNull(workspaceApiKeys.revokedAt),
        or(
          and(eq(workspaceApiKeys.kind, "personal"), eq(workspaceApiKeys.clientId, auth.cid)),
          and(eq(workspaceApiKeys.kind, "workspace"), eq(workspaces.clientId, auth.cid)),
        ),
      ))
      .limit(1)),
  ]);
  return grant || key;
}

/**
 * A change an agent made for this person: through an interactive grant (actorKind "agent") or one of
 * their API keys ("apiKey"); both keep actorId as the person. Any write counts, whatever the entity:
 * the step teaches handing work over, not one tool. Reads leave no row, so asking an agent to only
 * read a board leaves the step open; the step's copy asks for a change for that reason.
 */
function hasAgentWork(auth: AuthClaims): Promise<boolean> {
  return exists(db.select({ id: activityEvents.id })
    .from(activityEvents)
    .innerJoin(workspaces, eq(workspaces.id, activityEvents.workspaceId))
    .where(and(
      eq(workspaces.clientId, auth.cid),
      eq(activityEvents.actorId, auth.sub),
      inArray(activityEvents.actorKind, ["agent", "apiKey"]),
    ))
    .limit(1));
}

/**
 * Push is offered only where it can be delivered: the deployment has a VAPID key and the active
 * organisation has not switched push off. Done means the account toggle is on and at least one
 * device still holds a working subscription — the same two things the settings toggle writes.
 */
async function loadPushStep(auth: AuthClaims): Promise<{ available: boolean; done: boolean }> {
  const [config, settings, subscribed] = await Promise.all([
    getWebPushPublicConfig(auth.cid),
    db.select({ pushEnabled: notificationSettings.pushEnabled })
      .from(notificationSettings)
      .where(eq(notificationSettings.userId, auth.sub))
      .limit(1),
    exists(db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(and(
      eq(pushSubscriptions.userId, auth.sub),
      isNull(pushSubscriptions.disabledAt),
    )).limit(1)),
  ]);
  return {
    available: config.enabled && Boolean(config.publicKey),
    done: (settings[0]?.pushEnabled ?? false) && subscribed,
  };
}
