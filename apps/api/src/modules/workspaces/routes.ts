import { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { DEFAULT_WORKSPACE_CUSTOM_FIELDS } from "@kanera/shared/default-workspace-custom-fields";
import { DEFAULT_WORKSPACE_LABELS } from "@kanera/shared/default-workspace-labels";
import { DEFAULT_WORKSPACE_LIST_NAMES } from "@kanera/shared/default-workspace-lists";
import { automationActions, automations, boardGroups, boardInvitationGrants, boardInvitations, boardMembers, boardMirrors, boards, cardAssignees, cardLabelAssignments, cardLabels, cards, checklistTemplateItems, checklistTemplates, clientGuestSeats, clients, customFieldOptions, customFields, lists, users, workspaceMembers, workspaces, type AutomationActionConfig } from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { assertOrgRole, assertWorkspaceAccess, isOrgAdmin, orgRoleRanksAdmin } from "../../lib/access.js";
import { loadAssignedChecklistItems } from "../../lib/assigned-checklist-items.js";
import { emitActivityFeedItem, recordActivity } from "../../lib/activity.js";
import { cleanupUserBoardParticipation } from "../../lib/board-participation-cleanup.js";
import { loadAutomations } from "../../lib/automations.js";
import { applyChecklistTemplates, loadChecklistTemplates } from "../../lib/checklist-templates.js";
import { loadWorkspaceCustomFields } from "../../lib/custom-fields.js";
import { assertGuestBoardLimit } from "../../lib/board-guest-limits.js";
import { pinAdminToWorkspaceBoards, seedBoardMembersFromWorkspace, unpinAdminFromWorkspaceBoards } from "../../lib/board-membership.js";
import { isDueDateOverdue } from "../../lib/due-date.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { deleteExternalLinks } from "../../lib/external-links.js";
import { assertGuestEmailDoesNotMatchOwnerDomain } from "../../lib/guest-domain-policy.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { clearNotificationsForRevokedAccess } from "../../lib/notifications.js";
import { previewGuestBoardsCapacity, prunePaidGuestSeatIfBelowLimit } from "../../lib/paid-guest-seats.js";
import { newOpaqueToken } from "../../lib/tokens.js";
import { assertBoardLimit, assertGuestsAllowed, shouldEnableSeededAutomations } from "../../lib/tier-limits.js";
import { deleteWorkspaceCascade } from "../../lib/workspace-delete.js";
import { emitToBoard, emitToBoardAudience, emitToUser, emitToWorkspace } from "../../realtime/emit.js";
import { disconnectUserRealtimeSockets } from "../../realtime/io.js";

// A workspace must retain at least one admin, otherwise no one can manage it or its boards.
// Block removing or demoting the final admin.
async function assertNotLastAdmin(workspaceId: string, targetUserId: string) {
  const [target] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)))
    .limit(1);
  if (target?.role !== "admin") return;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "admin")));
  if ((row?.count ?? 0) <= 1) throw badRequest("cannot remove or downgrade the last workspace admin");
}

async function workspaceMemberRole(workspaceId: string, userId: string) {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

function localDateInTimezone(date: Date, timezone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
  }
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function addDays(localDate: string, days: number): string {
  const [yearString, monthString, dayString] = localDate.split("-");
  const year = Number(yearString);
  const month = Number(monthString);
  const day = Number(dayString);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

export async function workspaceRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/workspaces", async (req) => {
    // Personal credentials are not pinned to a workspace: list every workspace the owner can reach
    // and expose the same effective role the owner currently holds.
    if (req.auth.apiKeyKind === "personal") {
      const ownerIsOrgAdmin = orgRoleRanksAdmin(req.auth.role);
      const rows = ownerIsOrgAdmin
        ? await db
            .select({
              id: workspaces.id,
              clientId: workspaces.clientId,
              name: workspaces.name,
              kind: workspaces.kind,
              icon: workspaces.icon,
              accentColor: workspaces.accentColor,
              completedCardsActiveDays: workspaces.completedCardsActiveDays,
              boardLinkingEnabled: workspaces.boardLinkingEnabled,
              createdAt: workspaces.createdAt,
              updatedAt: workspaces.updatedAt,
              role: sql<"admin">`'admin'::workspace_role`.as("role"),
            })
            .from(workspaces)
            .where(and(eq(workspaces.clientId, req.auth.cid), ne(workspaces.kind, "board"), isNull(workspaces.archivedAt)))
            .orderBy(asc(workspaces.createdAt))
        : await db
            .select({
              id: workspaces.id,
              clientId: workspaces.clientId,
              name: workspaces.name,
              kind: workspaces.kind,
              icon: workspaces.icon,
              accentColor: workspaces.accentColor,
              completedCardsActiveDays: workspaces.completedCardsActiveDays,
              boardLinkingEnabled: workspaces.boardLinkingEnabled,
              createdAt: workspaces.createdAt,
              updatedAt: workspaces.updatedAt,
              role: workspaceMembers.role,
            })
            .from(workspaceMembers)
            .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
            .where(and(eq(workspaceMembers.userId, req.auth.sub), ne(workspaces.kind, "board"), isNull(workspaces.archivedAt)))
            .orderBy(asc(workspaces.createdAt));
      return rows;
    }

    if (req.auth.authKind === "apiKey") {
      const workspaceId = req.auth.apiKeyWorkspaceId!;
      return db
        .select({
          id: workspaces.id,
          clientId: workspaces.clientId,
          name: workspaces.name,
          kind: workspaces.kind,
          icon: workspaces.icon,
          accentColor: workspaces.accentColor,
          completedCardsActiveDays: workspaces.completedCardsActiveDays,
          boardLinkingEnabled: workspaces.boardLinkingEnabled,
          createdAt: workspaces.createdAt,
          updatedAt: workspaces.updatedAt,
          role: sql`${req.auth.apiKeyScope === "admin" ? "admin" : "member"}::workspace_role`.as("role"),
        })
        .from(workspaces)
        .where(and(eq(workspaces.id, workspaceId), eq(workspaces.clientId, req.auth.cid), isNull(workspaces.archivedAt)));
    }

    if (isOrgAdmin(req.auth)) {
      return db
        .select({
          id: workspaces.id,
          clientId: workspaces.clientId,
          name: workspaces.name,
          kind: workspaces.kind,
         icon: workspaces.icon,
         accentColor: workspaces.accentColor,
          completedCardsActiveDays: workspaces.completedCardsActiveDays,
          boardLinkingEnabled: workspaces.boardLinkingEnabled,
         createdAt: workspaces.createdAt,
         updatedAt: workspaces.updatedAt,
          role: sql<"admin">`'admin'::workspace_role`.as("role"),
        })
        .from(workspaces)
        // Archived workspaces (e.g. downgrade-archived) are hidden from listings.
        .where(and(eq(workspaces.clientId, req.auth.cid), ne(workspaces.kind, "board"), isNull(workspaces.archivedAt)))
        .orderBy(asc(workspaces.createdAt));
    }
    const rows = await db
      .select({
        id: workspaces.id,
        clientId: workspaces.clientId,
        name: workspaces.name,
        kind: workspaces.kind,
        icon: workspaces.icon,
        accentColor: workspaces.accentColor,
        completedCardsActiveDays: workspaces.completedCardsActiveDays,
        boardLinkingEnabled: workspaces.boardLinkingEnabled,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      // Archived workspaces (e.g. downgrade-archived) are hidden from listings.
      .where(and(eq(workspaceMembers.userId, req.auth.sub), ne(workspaces.kind, "board"), isNull(workspaces.archivedAt)))
      .orderBy(asc(workspaces.createdAt));
    return rows;
  });

  app.post("/workspaces", async (req, reply) => {
    assertOrgRole(req.auth, "admin");
    const body = dto.createWorkspaceBody.parse(req.body);
    const { workspace: ws, creatorMembership, initialBoard } = await db.transaction(async (tx) => {
      const [workspace] = await tx
        .insert(workspaces)
        .values({
          clientId: req.auth.cid,
          name: body.kind === "board" ? body.initialBoard!.name : body.name,
          kind: body.kind,
          // Standalone identity is mirrored at birth as well as on later PATCHes. Advanced API
          // callers cannot create a hidden workspace whose icon or color disagrees with its board.
          icon: body.kind === "board" ? body.initialBoard!.icon ?? null : body.icon ?? null,
          accentColor: body.kind === "board" ? body.initialBoard!.iconColor ?? null : null,
        })
        .returning();
      const [member] = await tx.insert(workspaceMembers).values({
        workspaceId: workspace!.id,
        userId: req.auth.sub,
        role: "admin",
      }).returning();
      if (!member) throw badRequest("could not add workspace member");

      const initialLists: { name: string; icon?: string | null }[] =
        body.lists ?? (body.listNames ?? [...DEFAULT_WORKSPACE_LIST_NAMES]).map((name) => ({ name }));
      // Blank onboarding intentionally sends an explicit empty list array so users can configure
      // workspace lists later. Omitted lists still seed the default workflow above.
      const initialListRows = initialLists.length > 0
        ? await tx.insert(lists).values(
          initialLists.map((list, index) => ({
            workspaceId: workspace!.id,
            name: list.name,
            icon: "icon" in list ? list.icon ?? null : null,
            position: String((index + 1) * 1000),
          })),
        ).returning()
        : [];

      const initialCustomFields = body.customFields ?? DEFAULT_WORKSPACE_CUSTOM_FIELDS;
      const initialCustomFieldRows = initialCustomFields.length > 0
        ? await tx.insert(customFields).values(
          initialCustomFields.map((field, index) => ({
            workspaceId: workspace!.id,
            name: field.name,
            icon: field.icon,
            type: field.type,
            allowMultiple: "allowMultiple" in field ? field.allowMultiple : false,
            position: String((index + 1) * 1000),
          })),
        ).returning()
        : [];
      const initialCustomFieldOptions = initialCustomFields.flatMap((field, fieldIndex) =>
          field.type === "select"
            ? ("options" in field ? field.options ?? [] : []).map((option, optionIndex) => ({
                fieldId: initialCustomFieldRows[fieldIndex]!.id,
                label: option.label,
                color: option.color ?? null,
                position: String((optionIndex + 1) * 1000),
              }))
            : [],
        );
      const initialCustomFieldOptionRows = initialCustomFieldOptions.length > 0
        ? await tx.insert(customFieldOptions).values(initialCustomFieldOptions).returning()
        : [];

      const initialLabels = body.labels ?? DEFAULT_WORKSPACE_LABELS;
      const initialLabelRows = initialLabels.length > 0
        ? await tx.insert(cardLabels).values(
          initialLabels.map((label, index) => ({
            workspaceId: workspace!.id,
            name: label.name,
            color: label.color ?? null,
            position: String((index + 1) * 1000),
          })),
        ).returning()
        : [];

      const initialChecklistTemplateRows = body.checklistTemplates?.length
        ? await tx.insert(checklistTemplates).values(
          body.checklistTemplates.map((template, index) => ({
            workspaceId: workspace!.id,
            title: template.title,
            position: String((index + 1) * 1000),
          })),
        ).returning()
        : [];
      const initialChecklistItems = body.checklistTemplates?.flatMap((template, templateIndex) =>
        template.items.map((text, itemIndex) => ({
          templateId: initialChecklistTemplateRows[templateIndex]!.id,
          text,
          position: String((itemIndex + 1) * 1000),
        })),
      ) ?? [];
      if (initialChecklistItems.length > 0) await tx.insert(checklistTemplateItems).values(initialChecklistItems);

      const normalizeSeedName = (name: string) => name.trim().toLocaleLowerCase();
      const listByName = new Map(initialListRows.map((list) => [normalizeSeedName(list.name), list]));
      const labelByName = new Map(initialLabelRows.map((label) => [normalizeSeedName(label.name), label]));
      const checklistTemplateByTitle = new Map(
        initialChecklistTemplateRows.map((template) => [normalizeSeedName(template.title), template]),
      );
      const customFieldByName = new Map(
        initialCustomFieldRows.map((field) => [normalizeSeedName(field.name), field]),
      );
      const customFieldOptionsByFieldId = new Map<string, Map<string, (typeof initialCustomFieldOptionRows)[number]>>();
      for (const option of initialCustomFieldOptionRows) {
        const fieldOptions = customFieldOptionsByFieldId.get(option.fieldId)
          ?? new Map<string, (typeof initialCustomFieldOptionRows)[number]>();
        fieldOptions.set(normalizeSeedName(option.label), option);
        customFieldOptionsByFieldId.set(option.fieldId, fieldOptions);
      }

      if (body.automations?.length) {
        // Hosted Free receives every recipe in a disabled state instead of an arbitrary enabled
        // subset. Paid, trial, and self-hosted workspaces can use the complete preset immediately.
        const enabled = await shouldEnableSeededAutomations(req.auth.cid, tx);
        for (const [automationIndex, recipe] of body.automations.entries()) {
          const triggerList = recipe.trigger.type === "card_enters_list"
            ? listByName.get(normalizeSeedName(recipe.trigger.listName))
            : null;
          const triggerLabel = recipe.trigger.type === "card_label_set"
            ? labelByName.get(normalizeSeedName(recipe.trigger.labelName))
            : null;
          if (recipe.trigger.type === "card_enters_list" && !triggerList) throw badRequest(`automation trigger list not found: ${recipe.trigger.listName}`);
          if (recipe.trigger.type === "card_label_set" && !triggerLabel) throw badRequest(`automation trigger label not found: ${recipe.trigger.labelName}`);

          const [automation] = await tx.insert(automations).values({
            workspaceId: workspace!.id,
            enabled,
            position: String((automationIndex + 1) * 1000),
            triggerType: recipe.trigger.type,
            triggerListId: triggerList?.id ?? null,
            triggerLabelId: triggerLabel?.id ?? null,
            applyOnCreate: recipe.trigger.type === "card_enters_list" ? recipe.trigger.applyOnCreate : true,
            applyOnMove: recipe.trigger.type === "card_enters_list" ? recipe.trigger.applyOnMove : true,
          }).returning();

          const actionRows = recipe.actions.map((action, actionIndex) => {
            let config: AutomationActionConfig = {};
            if (action.type === "add_labels" || action.type === "remove_labels") {
              config = {
                labelIds: action.labelNames.map((name) => {
                  const label = labelByName.get(normalizeSeedName(name));
                  if (!label) throw badRequest(`automation action label not found: ${name}`);
                  return label.id;
                }),
              };
            } else if (action.type === "apply_checklists") {
              config = {
                templateIds: action.checklistTemplateTitles.map((title) => {
                  const template = checklistTemplateByTitle.get(normalizeSeedName(title));
                  if (!template) throw badRequest(`automation action checklist template not found: ${title}`);
                  return template.id;
                }),
              };
            } else if (action.type === "set_due_date") {
              config = { offsetDays: action.offsetDays, slot: action.slot };
            } else if (action.type === "set_completion") {
              config = { completed: action.completed };
            } else if (action.type === "move_to_list") {
              const list = listByName.get(normalizeSeedName(action.listName));
              if (!list) throw badRequest(`automation action list not found: ${action.listName}`);
              config = { listId: list.id, placement: action.placement };
            } else if (action.type === "populate_custom_field") {
              const field = customFieldByName.get(normalizeSeedName(action.fieldName));
              if (!field) throw badRequest(`automation action custom field not found: ${action.fieldName}`);
              if (action.value.kind === "select") {
                const fieldOptions = customFieldOptionsByFieldId.get(field.id)
                  ?? new Map<string, (typeof initialCustomFieldOptionRows)[number]>();
                config = {
                  fieldId: field.id,
                  onlyIfEmpty: action.onlyIfEmpty,
                  value: {
                    kind: "select",
                    optionIds: action.value.optionLabels.map((label) => {
                      const option = fieldOptions.get(normalizeSeedName(label));
                      if (!option) throw badRequest(`automation action custom field option not found: ${label}`);
                      return option.id;
                    }),
                  },
                };
              } else {
                config = { fieldId: field.id, onlyIfEmpty: action.onlyIfEmpty, value: action.value };
              }
            }
            return {
              automationId: automation!.id,
              type: action.type,
              config,
              position: String((actionIndex + 1) * 1000),
            };
          });
          await tx.insert(automationActions).values(actionRows);
          await recordActivity(tx, {
            boardId: null,
            workspaceId: workspace!.id,
            actorId: req.auth.sub,
            entityType: "workspace",
            entityId: workspace!.id,
            action: "automation:created",
            payload: { automationId: automation!.id, seededFromWorkspaceTemplate: true },
          });
        }
        // The new workspace has no joined admin clients until after commit, so separate realtime
        // creates cannot be observed. The first workspace load includes every recipe and action.
      }

      let createdInitialBoard = null;
      if (body.initialBoard) {
        await assertBoardLimit(req.auth.cid, tx);
        const [board] = await tx
          .insert(boards)
          .values({
            workspaceId: workspace!.id,
            name: body.initialBoard.name,
            icon: body.initialBoard.icon ?? null,
            iconColor: body.initialBoard.iconColor ?? null,
            position: "1000",
          })
          .returning();

        // Seed explicit board membership from the workspace roster (creator = owner) so board
        // access is set up from creation; board membership is the sole access model.
        await seedBoardMembersFromWorkspace(tx, board!.id, workspace!.id, req.auth.sub);

        await recordActivity(tx, {
          boardId: board!.id,
          workspaceId: workspace!.id,
          actorId: req.auth.sub,
          entityType: "board",
          entityId: board!.id,
          action: "created",
          payload: { name: board!.name },
        });

        if (body.cards?.length) {
          // Seed content is committed with the board before board:created is published, so no client
          // can join this board room early enough to consume separate card/checklist create events.
          // Keep the activity rows for audit history; the first board load reads the complete state.
          const cardCountByList = new Map<string, number>();

          for (const starterCard of body.cards) {
            const list = listByName.get(normalizeSeedName(starterCard.listName));
            if (!list) throw badRequest(`starter card list not found: ${starterCard.listName}`);
            const listCardIndex = cardCountByList.get(list.id) ?? 0;
            cardCountByList.set(list.id, listCardIndex + 1);
            const [card] = await tx.insert(cards).values({
              boardId: board!.id,
              listId: list.id,
              title: starterCard.title,
              description: starterCard.description,
              position: String((listCardIndex + 1) * 1000),
              createdById: req.auth.sub,
            }).returning();

            const starterLabels = (starterCard.labelNames ?? []).map((name) => {
              const label = labelByName.get(normalizeSeedName(name));
              if (!label) throw badRequest(`starter card label not found: ${name}`);
              return label;
            });
            if (starterLabels.length > 0) {
              await tx.insert(cardLabelAssignments).values(
                starterLabels.map((label) => ({ cardId: card!.id, labelId: label.id })),
              );
            }

            await recordActivity(tx, {
              boardId: board!.id,
              workspaceId: workspace!.id,
              actorId: req.auth.sub,
              entityType: "card",
              entityId: card!.id,
              action: "created",
              payload: { title: card!.title, listId: card!.listId, seededFromWorkspaceTemplate: true },
            });

            const checklistTemplateIds = (starterCard.checklistTemplateTitles ?? []).map((title) => {
              const template = checklistTemplateByTitle.get(normalizeSeedName(title));
              if (!template) throw badRequest(`starter card checklist template not found: ${title}`);
              return template.id;
            });
            if (checklistTemplateIds.length > 0) {
              await applyChecklistTemplates(tx, {
                cardId: card!.id,
                boardId: board!.id,
                workspaceId: workspace!.id,
                actorId: req.auth.sub,
                templateIds: checklistTemplateIds,
              });
            }
          }
        }

        createdInitialBoard = board!;
      }

      return { workspace: workspace!, creatorMembership: member, initialBoard: createdInitialBoard };
    });
    const [creator] = await db
      .select({ email: users.email, displayName: users.displayName, avatarUrl: users.avatarUrl, lastOnlineAt: users.lastOnlineAt })
      .from(users)
      .where(eq(users.id, req.auth.sub))
      .limit(1);
    // The creator's other tabs were not in workspace:${ws.id} when the workspace-scoped events
    // fired. Send the membership event directly so they join the room and refresh the home model.
    emitToUser(req.auth.sub, "workspace:member:added", {
      workspaceId: ws.id,
      member: withSignedMedia(req.auth.cid, {
        ...creatorMembership,
        email: creator?.email,
        displayName: creator?.displayName,
        avatarUrl: creator?.avatarUrl,
        lastOnlineAt: creator?.lastOnlineAt,
      }),
    });
    if (initialBoard) void emitToBoardAudience(initialBoard.id, "board:created", { workspaceId: ws.id, board: initialBoard }, { workspaceId: ws.id });
    return reply.status(201).send(initialBoard ? { ...ws, initialBoard } : ws);
  });

  app.get("/workspaces/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { role } = await assertWorkspaceAccess(req.auth, id);
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (!workspace) throw notFound();
    const workspaceLists = await db
      .select()
      .from(lists)
      .where(and(eq(lists.workspaceId, id), isNull(lists.archivedAt)))
      .orderBy(asc(lists.position));
    const workspaceFields = await loadWorkspaceCustomFields(id);
    const workspaceLabels = await db
      .select()
      .from(cardLabels)
      .where(eq(cardLabels.workspaceId, id))
      .orderBy(asc(cardLabels.position));
    const checklistTemplates = await loadChecklistTemplates(id);
    const automations = await loadAutomations(id);
    return { workspace, role, lists: workspaceLists, customFields: workspaceFields, cardLabels: workspaceLabels, checklistTemplates, automations };
  });

  app.patch("/workspaces/:id", async (req) => {
    const { id } = req.params as { id: string };
    await assertWorkspaceAccess(req.auth, id, "admin");
    const body = dto.updateWorkspaceBody.parse(req.body);
    const { workspace, mirroredBoard, deletedMirrors } = await db.transaction(async (tx) => {
      const mirrorsToDelete = body.boardLinkingEnabled === false
        ? await tx.select().from(boardMirrors).where(or(eq(boardMirrors.sourceWorkspaceId, id), eq(boardMirrors.targetWorkspaceId, id)))
        : [];
      // Mirror-created card links are not foreign keys to the mirror row. Remove those durable
      // associations before deleting the mirror definitions so card link indicators cannot linger.
      for (const mirror of mirrorsToDelete) {
        await deleteExternalLinks({ workspaceId: mirror.targetWorkspaceId, provider: `mirror:${mirror.id}` }, tx);
      }
      if (mirrorsToDelete.length > 0) {
        await tx.delete(boardMirrors).where(inArray(boardMirrors.id, mirrorsToDelete.map((mirror) => mirror.id)));
      }
      const [workspace] = await tx
        .update(workspaces)
        .set({
          ...(body.name !== undefined && { name: body.name }),
          ...(body.icon !== undefined && { icon: body.icon }),
          ...(body.accentColor !== undefined && { accentColor: body.accentColor }),
          ...(body.completedCardsActiveDays !== undefined && { completedCardsActiveDays: body.completedCardsActiveDays }),
          ...(body.boardLinkingEnabled !== undefined && { boardLinkingEnabled: body.boardLinkingEnabled }),
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, id))
        .returning();
      let mirroredBoard: typeof boards.$inferSelect | null = null;
      const updatesStandaloneBoard = workspace!.kind === "board" &&
        (body.name !== undefined || body.icon !== undefined || body.accentColor !== undefined);
      if (updatesStandaloneBoard) {
        // Standalone identity lives on both rows: settings edit the hidden workspace while every
        // board-facing surface renders the board. Keep one activity entry and emit both full entities.
        const [updatedBoard] = await tx
          .update(boards)
          .set({
            ...(body.name !== undefined && { name: body.name }),
            ...(body.icon !== undefined && { icon: body.icon }),
            ...(body.accentColor !== undefined && { iconColor: body.accentColor }),
            updatedAt: new Date(),
          })
          .where(eq(boards.workspaceId, id))
          .returning();
        mirroredBoard = updatedBoard ?? null;
      }
      await recordActivity(tx, {
        boardId: null,
        workspaceId: id,
        actorId: req.auth.sub,
        entityType: "workspace",
        entityId: id,
        action: "updated",
        payload: { ...body, ...(mirrorsToDelete.length > 0 && { deletedBoardLinkCount: mirrorsToDelete.length }) },
      });
      return { workspace: workspace!, mirroredBoard, deletedMirrors: mirrorsToDelete };
    });
    await emitToWorkspace(id, "workspace:updated", { workspace });
    if (mirroredBoard) await emitToBoardAudience(mirroredBoard.id, "board:updated", { board: mirroredBoard }, { workspaceId: id });
    // Disabling linking can remove cross-workspace relationships. Notify both board rooms for every
    // deleted mirror so the other workspace also drops stale link counts and management rows.
    await Promise.all(deletedMirrors.flatMap((mirror) => {
      const payload = { mirrorId: mirror.id, sourceBoardId: mirror.sourceBoardId, targetBoardId: mirror.targetBoardId };
      return [...new Set([mirror.sourceBoardId, mirror.targetBoardId])].map((boardId) =>
        emitToBoard(boardId, SERVER_EVENTS.BOARD_MIRROR_DELETED, payload),
      );
    }));
    return workspace;
  });

  app.delete("/workspaces/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, id, "admin");

    await deleteWorkspaceCascade({ workspaceId: id, clientId });
    return reply.status(204).send();
  });

  app.get("/workspaces/:id/members", async (req) => {
    const { id } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, id);
    const rows = await db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        addedAt: workspaceMembers.addedAt,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        lastOnlineAt: users.lastOnlineAt,
        orgRole: users.clientRole,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, id))
      .orderBy(asc(workspaceMembers.addedAt));
    const explicitUserIds = new Set(rows.map((row) => row.userId));
    const inheritedAdmins = await db
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        lastOnlineAt: users.lastOnlineAt,
        orgRole: users.clientRole,
        addedAt: users.createdAt,
      })
      .from(users)
      .where(and(eq(users.clientId, clientId), inArray(users.clientRole, ["owner", "admin"]), isNull(users.removedAt)));
    const effectiveRows = [
      ...rows,
      ...inheritedAdmins
        .filter((user) => !explicitUserIds.has(user.userId))
        .map((user) => ({ ...user, workspaceId: id, role: "admin" as const })),
    ];
    return effectiveRows.map((row) => withSignedMedia(req.auth.cid, {
      ...row,
      // Organisation owners/admins inherit workspace-admin authority and cannot be downgraded
      // inside an individual workspace, regardless of the historical workspace row value.
      role: row.orgRole === "owner" || row.orgRole === "admin" ? "admin" as const : row.role,
    }));
  });

  app.get("/workspaces/:id/member-candidates", async (req) => {
    const { id } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, id, "admin");
    return db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
      })
      .from(users)
      // Organisation owners/admins already inherit this workspace and are shown in its roster;
      // only ordinary organisation members can be explicitly added through this picker.
      .where(and(eq(users.clientId, clientId), eq(users.clientRole, "member"), isNull(users.removedAt)))
      .orderBy(asc(users.createdAt));
  });

  app.post("/workspaces/:id/members", async (req) => {
    const { id } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, id, "admin");
    const body = dto.addWorkspaceMemberBody.parse(req.body);

    // Verify the target user belongs to the same organisation
    const [targetUser] = await db
      .select({ id: users.id, clientId: users.clientId, email: users.email, displayName: users.displayName, avatarUrl: users.avatarUrl, lastOnlineAt: users.lastOnlineAt, orgRole: users.clientRole })
      .from(users)
      .where(eq(users.id, body.userId))
      .limit(1);
    if (!targetUser || targetUser.clientId !== clientId) throw notFound("user not found");

    // Check they're not already a member
    const [existing] = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, body.userId)))
      .limit(1);
    if (existing) throw badRequest("user is already a workspace member");

    const effectiveRole = targetUser.orgRole === "owner" || targetUser.orgRole === "admin" ? "admin" as const : body.role;
    const [member] = await db
      .insert(workspaceMembers)
      .values({ workspaceId: id, userId: body.userId, role: effectiveRole })
      .returning();
    if (!member) throw badRequest("could not add workspace member");
    // A new admin is on every board: materialize their pinned editor rows immediately.
    if (member.role === "admin") await pinAdminToWorkspaceBoards(db, id, body.userId);
    const payload = withSignedMedia(req.auth.cid, { ...member, orgRole: targetUser.orgRole, email: targetUser.email, displayName: targetUser.displayName, avatarUrl: targetUser.avatarUrl, lastOnlineAt: targetUser.lastOnlineAt });
    await recordActivity(db, {
      boardId: null,
      workspaceId: id,
      actorId: req.auth.sub,
      entityType: "workspaceMember",
      entityId: body.userId,
      action: "added",
      payload: { userId: body.userId, role: member.role, email: targetUser.email, displayName: targetUser.displayName },
    });
    emitToWorkspace(id, "workspace:member:added", { workspaceId: id, member: payload });
    // The newly added user was not in workspace:${id} while this mutation was emitted, so send the
    // same event to their user room. The web shell uses this to join the workspace room immediately.
    emitToUser(body.userId, "workspace:member:added", { workspaceId: id, member: payload });
    return payload;
  });

  app.patch("/workspaces/:id/members/:userId", async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    if (userId === req.auth.sub) throw badRequest("cannot change your own role");
    await assertWorkspaceAccess(req.auth, id, "admin");
    const body = dto.updateWorkspaceMemberBody.parse(req.body);
    const targetRole = await workspaceMemberRole(id, userId);
    if (!targetRole) throw notFound();
    const [targetUser] = await db.select({ orgRole: users.clientRole }).from(users).where(eq(users.id, userId)).limit(1);
    if (!targetUser) throw notFound();
    if (targetUser.orgRole === "owner" || targetUser.orgRole === "admin") {
      throw badRequest("organisation owners and admins are always workspace admins");
    }
    // Demoting the final admin would leave the workspace unmanageable.
    if (targetRole === "admin" && body.role !== "admin") await assertNotLastAdmin(id, userId);
    const [member] = await db
      .update(workspaceMembers)
      .set({ role: body.role })
      .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)))
      .returning();
    if (!member) throw notFound();
    // Keep board membership in sync with the workspace role change: promotion materializes pinned
    // editor rows; demotion retains them as ordinary editor access so the member remains on boards.
    if (member.role === "admin") await pinAdminToWorkspaceBoards(db, id, userId);
    else if (targetRole === "admin") await unpinAdminFromWorkspaceBoards(db, id, userId);
    await recordActivity(db, {
      boardId: null,
      workspaceId: id,
      actorId: req.auth.sub,
      entityType: "workspaceMember",
      entityId: userId,
      action: "updated",
      payload: { userId, fromRole: targetRole, toRole: member.role },
    });
    emitToWorkspace(id, "workspace:member:updated", { workspaceId: id, member });
    disconnectUserRealtimeSockets(userId);
    return member;
  });

  app.delete("/workspaces/:id/members/:userId", async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    if (userId === req.auth.sub) throw badRequest("cannot remove yourself");
    await assertWorkspaceAccess(req.auth, id, "admin");
    const targetRole = await workspaceMemberRole(id, userId);
    if (!targetRole) throw notFound();
    const [targetUser] = await db.select({ orgRole: users.clientRole }).from(users).where(eq(users.id, userId)).limit(1);
    if (!targetUser) throw notFound();
    if (targetUser.orgRole === "owner" || targetUser.orgRole === "admin") {
      throw badRequest("organisation owners and admins cannot be removed from a workspace");
    }
    await assertNotLastAdmin(id, userId);

    const cleanup = await db.transaction(async (tx) => {
      const workspaceBoards = await tx.select({ id: boards.id }).from(boards).where(eq(boards.workspaceId, id));
      const boardIds = workspaceBoards.map((board) => board.id);
      const participation = await cleanupUserBoardParticipation(tx, {
        userId,
        boardIds,
        actorId: req.auth.sub,
        // The workspace-wide cleanup below also removes non-board notification rows.
        clearNotifications: false,
      });

      await tx.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)));
      await clearNotificationsForRevokedAccess(tx, { userId, workspaceIds: [id] });
      await recordActivity(tx, {
        boardId: null,
        workspaceId: id,
        actorId: req.auth.sub,
        entityType: "workspaceMember",
        entityId: userId,
        action: "removed",
        payload: { userId, role: targetRole },
      });

      return participation;
    });
    await emitToWorkspace(id, "workspace:member:removed", { workspaceId: id, userId });
    for (const boardId of cleanup.removedBoardIds) {
      await emitToBoard(boardId, "board:member:removed", { boardId, userId });
    }
    for (const update of cleanup.assigneeUpdates) {
      await emitToBoard(update.boardId, "card:assignees:set", update);
    }
    for (const update of cleanup.checklistItemUpdates) {
      await emitToBoard(update.boardId, "card:checklistItem:updated", update);
    }
    for (const update of cleanup.activities) {
      await emitActivityFeedItem(update.boardId, update.cardId, update.activity, { notify: false });
    }
    disconnectUserRealtimeSockets(userId);
    return reply.status(204).send();
  });

  app.get("/workspaces/:id/boards", async (req) => {
    const { id } = req.params as { id: string };
    await assertWorkspaceAccess(req.auth, id);
    return db.select().from(boards).where(and(eq(boards.workspaceId, id), isNull(boards.archivedAt))).orderBy(asc(boards.position));
  });

  app.get("/workspaces/:id/guests", async (req) => {
    const { id } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, id, "admin");
    const [workspaceBoards, acceptedGuests, pendingInvites] = await Promise.all([
      db
        .select({
          id: boards.id,
          name: boards.name,
          icon: boards.icon,
          iconColor: boards.iconColor,
          position: boards.position,
        })
        .from(boards)
        .where(and(eq(boards.workspaceId, id), isNull(boards.archivedAt)))
        .orderBy(asc(boards.position)),
      db
        .select({
          boardId: boardMembers.boardId,
          boardName: boards.name,
          userId: boardMembers.userId,
          role: boardMembers.role,
          assignedItemsOnly: boardMembers.assignedItemsOnly,
          addedAt: boardMembers.addedAt,
          email: users.email,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          lastOnlineAt: users.lastOnlineAt,
          clientId: users.clientId,
          paidGuestSeat: isNotNull(clientGuestSeats.userId),
        })
        .from(boardMembers)
        .innerJoin(boards, eq(boards.id, boardMembers.boardId))
        .innerJoin(users, eq(users.id, boardMembers.userId))
        .leftJoin(clientGuestSeats, and(eq(clientGuestSeats.clientId, clientId), eq(clientGuestSeats.userId, boardMembers.userId)))
        .where(and(eq(boards.workspaceId, id), ne(users.clientId, clientId), isNull(boards.archivedAt)))
        .orderBy(asc(boards.position), asc(users.displayName)),
      db
        .select({
          id: boardInvitations.id,
          boardId: boardInvitationGrants.boardId,
          boardName: boards.name,
          email: boardInvitations.email,
          role: boardInvitationGrants.role,
          assignedItemsOnly: boardInvitationGrants.assignedItemsOnly,
          expiresAt: boardInvitations.expiresAt,
          createdAt: boardInvitations.createdAt,
        })
        .from(boardInvitations)
        .innerJoin(boardInvitationGrants, eq(boardInvitationGrants.invitationId, boardInvitations.id))
        .innerJoin(boards, eq(boards.id, boardInvitationGrants.boardId))
        .where(
          and(
            eq(boards.workspaceId, id),
            isNull(boards.archivedAt),
            isNull(boardInvitations.revokedAt),
            isNull(boardInvitations.acceptedAt),
            sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
          ),
        )
        .orderBy(asc(boards.position), asc(boardInvitations.createdAt)),
    ]);

    const pendingByInvite = new Map<string, typeof pendingInvites[number] & { boards: Array<{ boardId: string; boardName: string; role: string; assignedItemsOnly: boolean }> }>();
    for (const invite of pendingInvites) {
      const current = pendingByInvite.get(invite.id);
      if (current) {
        current.boards.push({ boardId: invite.boardId, boardName: invite.boardName, role: invite.role, assignedItemsOnly: invite.assignedItemsOnly });
      } else {
        pendingByInvite.set(invite.id, {
          ...invite,
          boards: [{ boardId: invite.boardId, boardName: invite.boardName, role: invite.role, assignedItemsOnly: invite.assignedItemsOnly }],
        });
      }
    }

    return {
      boards: workspaceBoards,
      acceptedGuests: acceptedGuests.map((guest) => ({
        ...guest,
        avatarUrl: withSignedMedia(guest.clientId, { avatarUrl: guest.avatarUrl }).avatarUrl,
      })),
      pendingInvites: [...pendingByInvite.values()],
    };
  });

  app.post("/workspaces/:id/guests/seat-preview", async (req) => {
    const { id } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, id, "admin");
    await assertGuestsAllowed(clientId);
    const raw = req.body as { boardId?: unknown; email?: unknown } | null;
    if (!raw || typeof raw.boardId !== "string") throw badRequest("boardId is required");
    const body = dto.createBoardInvitationBody.parse(req.body);
    await assertGuestEmailDoesNotMatchOwnerDomain({ hostClientId: clientId, email: body.email });

    const [boardRow] = await db
      .select({ id: boards.id })
      .from(boards)
      .where(and(eq(boards.id, raw.boardId), eq(boards.workspaceId, id), isNull(boards.archivedAt)))
      .limit(1);
    if (!boardRow) throw notFound("board not found");

    const [pendingInvite] = await db
      .select({ id: boardInvitations.id })
      .from(boardInvitations)
      .innerJoin(boardInvitationGrants, eq(boardInvitationGrants.invitationId, boardInvitations.id))
      .where(and(
        eq(boardInvitations.clientId, clientId),
        eq(boardInvitationGrants.boardId, boardRow.id),
        sql`lower(${boardInvitations.email}) = lower(${body.email})`,
        isNull(boardInvitations.revokedAt),
        isNull(boardInvitations.acceptedAt),
        sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
      ))
      .limit(1);
    if (pendingInvite) throw conflict("There is already a pending invite for this email and board.");

    const [existingUser] = await db
      .select({ id: users.id, clientId: users.clientId })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    if (!existingUser) return { paidGuestSeatRequired: false, paidGuestSeatActive: false };
    const [existingBoardAccess] = await db
      .select({ userId: boardMembers.userId })
      .from(boardMembers)
      .where(and(eq(boardMembers.boardId, boardRow.id), eq(boardMembers.userId, existingUser.id)))
      .limit(1);
    if (existingBoardAccess) throw conflict("This person already has access to this board.");
    if (existingUser.clientId === clientId) throw badRequest("Organisation members are added directly to the board, not invited as guests.");

    await assertGuestEmailDoesNotMatchOwnerDomain({ hostClientId: clientId, email: body.email, targetClientId: existingUser.clientId });
    return previewGuestBoardsCapacity({
      hostClientId: clientId,
      boardIds: [boardRow.id],
      userId: existingUser.id,
      targetClientId: existingUser.clientId,
    });
  });

  app.post("/workspaces/:id/guests/invitations", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, id, "admin");
    // Free-tier hosted orgs cannot use guests at all. Paid/trial/self-hosted fall through to the
    // per-org guest board cap below.
    await assertGuestsAllowed(clientId);
    const raw = req.body as { boardId?: unknown } | null;
    if (!raw || typeof raw.boardId !== "string") throw badRequest("boardId is required");
    const body = dto.createBoardInvitationBody.parse(req.body);
    await assertGuestEmailDoesNotMatchOwnerDomain({ hostClientId: clientId, email: body.email });

    const [boardRow] = await db
      .select({
        id: boards.id,
        boardName: boards.name,
        clientName: clients.name,
      })
      .from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(clients, eq(clients.id, workspaces.clientId))
      .where(and(eq(boards.id, raw.boardId), eq(boards.workspaceId, id), isNull(boards.archivedAt)))
      .limit(1);
    if (!boardRow) throw notFound("board not found");

    // Account existence wins over any stale pending invitation: known users receive access
    // immediately and an access-granted notification, never another onboarding invite.
    const [existingUser] = await db
      .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, lastOnlineAt: users.lastOnlineAt, clientId: users.clientId })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);

    const [pendingInvite] = await db
      .select({ id: boardInvitations.id, expiresAt: boardInvitations.expiresAt, createdAt: boardInvitations.createdAt })
      .from(boardInvitations)
      .where(
        and(
          eq(boardInvitations.clientId, clientId),
          sql`lower(${boardInvitations.email}) = lower(${body.email})`,
          isNull(boardInvitations.revokedAt),
          isNull(boardInvitations.acceptedAt),
          sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
        ),
      )
      .limit(1);
    if (pendingInvite && !existingUser) {
      const [existingGrant] = await db
        .select({ invitationId: boardInvitationGrants.invitationId })
        .from(boardInvitationGrants)
        .where(and(eq(boardInvitationGrants.invitationId, pendingInvite.id), eq(boardInvitationGrants.boardId, boardRow.id)))
        .limit(1);
      if (existingGrant) throw conflict("There is already a pending invite for this email and board.");
      const token = newOpaqueToken();
      await db.transaction(async (tx) => {
        await tx
          .insert(boardInvitationGrants)
          .values({ invitationId: pendingInvite.id, boardId: boardRow.id, role: body.role, assignedItemsOnly: body.assignedItemsOnly });
        // Only token hashes are persisted. Rotate the link when the invitation changes so the
        // complete, updated invitation can be emailed without storing a reusable secret.
        await tx
          .update(boardInvitations)
          .set({ tokenHash: token.hash })
          .where(eq(boardInvitations.id, pendingInvite.id));
      });
      const [inviter, grants] = await Promise.all([
        db.select({ displayName: users.displayName }).from(users).where(eq(users.id, req.auth.sub)).limit(1),
        db
          .select({ boardName: boards.name, role: boardInvitationGrants.role })
          .from(boardInvitationGrants)
          .innerJoin(boards, eq(boards.id, boardInvitationGrants.boardId))
          .where(eq(boardInvitationGrants.invitationId, pendingInvite.id))
          .orderBy(asc(boards.position)),
      ]);
      await app.mailer.sendBoardInvite(body.email, {
        boards: grants,
        orgName: boardRow.clientName,
        invitedByName: inviter[0]?.displayName ?? "A Kanera administrator",
        acceptUrl: `${env.WEB_ORIGIN}/board-invite?token=${encodeURIComponent(token.raw)}`,
      });
      return reply.status(201).send({
        status: "invited" as const,
        token: token.raw,
        invite: {
          id: pendingInvite.id,
          boardId: boardRow.id,
          boardName: boardRow.boardName,
          email: body.email,
          role: body.role,
          expiresAt: pendingInvite.expiresAt,
          createdAt: pendingInvite.createdAt,
          boards: [{ boardId: boardRow.id, boardName: boardRow.boardName, role: body.role, assignedItemsOnly: body.assignedItemsOnly }],
        },
      });
    }

    if (existingUser) {
      const [existingBoardAccess] = await db
        .select({ userId: boardMembers.userId })
        .from(boardMembers)
        .where(and(eq(boardMembers.boardId, boardRow.id), eq(boardMembers.userId, existingUser.id)))
        .limit(1);
      if (existingBoardAccess) throw conflict("This person already has access to this board.");
      if (existingUser.clientId === clientId) throw badRequest("Organisation members are added directly to the board, not invited as guests.");
      await assertGuestEmailDoesNotMatchOwnerDomain({ hostClientId: clientId, email: body.email, targetClientId: existingUser.clientId });
      // Seat-pool gate + membership insert in one transaction so the capacity check is race-safe.
      // Crossing the free guest-board cap consumes a pooled seat; a full pool throws 402 SEAT_LIMIT_REACHED.
      const { row: member, guestSeat } = await db.transaction(async (tx) => {
        const seat = await assertGuestBoardLimit({
          hostClientId: clientId,
          boardId: boardRow.id,
          userId: existingUser.id,
          targetClientId: existingUser.clientId,
          createdById: req.auth.sub,
          tx,
        });
        const [inserted] = await tx
          .insert(boardMembers)
          .values({ boardId: boardRow.id, userId: existingUser.id, role: body.role, assignedItemsOnly: body.assignedItemsOnly })
          .onConflictDoUpdate({
            target: [boardMembers.boardId, boardMembers.userId],
            set: { role: body.role, assignedItemsOnly: body.assignedItemsOnly },
          })
          .returning();
        return { row: inserted, guestSeat: seat };
      });

      const [inviter] = await db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, req.auth.sub))
        .limit(1);
      // Each newly granted board is actionable access in its own right, including when the
      // recipient is already a guest on another board in this organisation.
      await app.mailer.sendBoardAccessGranted(body.email, {
        displayName: existingUser.displayName,
        boardName: boardRow.boardName,
        orgName: boardRow.clientName,
        invitedByName: inviter?.displayName ?? "A Kanera administrator",
        role: member!.role,
        boardUrl: `${env.WEB_ORIGIN}/b/${boardRow.id}`,
      });

      const payload = {
        boardId: boardRow.id,
        member: member!,
        user: {
          userId: existingUser.id,
          displayName: existingUser.displayName,
          avatarUrl: withSignedMedia(existingUser.clientId, { avatarUrl: existingUser.avatarUrl }).avatarUrl,
          lastOnlineAt: existingUser.lastOnlineAt,
          role: member!.role,
          source: "board" as const,
          clientId: existingUser.clientId,
        },
      };
      emitToBoard(boardRow.id, "board:member:added", payload);
      emitToUser(existingUser.id, "board:member:added", payload);
      return reply.status(201).send({
        status: "added" as const,
        guest: existingUser.clientId !== clientId
          ? {
            boardId: boardRow.id,
            boardName: boardRow.boardName,
            userId: existingUser.id,
            role: member!.role,
            addedAt: member!.addedAt,
            email: body.email,
            displayName: existingUser.displayName,
            avatarUrl: withSignedMedia(existingUser.clientId, { avatarUrl: existingUser.avatarUrl }).avatarUrl,
            lastOnlineAt: existingUser.lastOnlineAt,
            clientId: existingUser.clientId,
            paidGuestSeat: guestSeat.paidGuestSeatActive,
          }
          : null,
      });
    }

    const token = newOpaqueToken();
    const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null;
    const [invitation] = await db
      .insert(boardInvitations)
      .values({
        clientId,
        boardId: boardRow.id,
        email: body.email,
        role: body.role,
        assignedItemsOnly: body.assignedItemsOnly,
        tokenHash: token.hash,
        invitedById: req.auth.sub,
        expiresAt,
      })
      .returning();
    await db.insert(boardInvitationGrants).values({ invitationId: invitation!.id, boardId: boardRow.id, role: body.role, assignedItemsOnly: body.assignedItemsOnly });

    const [inviter] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, req.auth.sub))
      .limit(1);
    await app.mailer.sendBoardInvite(body.email, {
      boards: [{ boardName: boardRow.boardName, role: body.role }],
      orgName: boardRow.clientName,
      invitedByName: inviter?.displayName ?? "A Kanera administrator",
      acceptUrl: `${env.WEB_ORIGIN}/board-invite?token=${encodeURIComponent(token.raw)}`,
    });

    return reply.status(201).send({
      status: "invited" as const,
      token: token.raw,
      invite: {
        id: invitation!.id,
        boardId: boardRow.id,
        boardName: boardRow.boardName,
        email: invitation!.email,
        role: invitation!.role,
        expiresAt: invitation!.expiresAt,
        createdAt: invitation!.createdAt,
        boards: [{ boardId: boardRow.id, boardName: boardRow.boardName, role: invitation!.role, assignedItemsOnly: invitation!.assignedItemsOnly }],
      },
    });
  });

  app.delete("/workspaces/:id/guests/invitations/:invitationId", async (req, reply) => {
    const { id, invitationId } = req.params as { id: string; invitationId: string };
    await assertWorkspaceAccess(req.auth, id, "admin");
    const [invitation] = await db
      .select({ id: boardInvitations.id })
      .from(boardInvitations)
      .innerJoin(boardInvitationGrants, eq(boardInvitationGrants.invitationId, boardInvitations.id))
      .innerJoin(boards, eq(boards.id, boardInvitationGrants.boardId))
      .where(and(eq(boardInvitations.id, invitationId), eq(boards.workspaceId, id)))
      .limit(1);
    if (!invitation) throw notFound();
    await db.update(boardInvitations).set({ revokedAt: new Date() }).where(eq(boardInvitations.id, invitationId));
    return reply.status(204).send();
  });

  app.delete("/workspaces/:id/guests/:boardId/:userId", async (req, reply) => {
    const { id, boardId, userId } = req.params as { id: string; boardId: string; userId: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, id, "admin");
    const [member] = await db
      .select({ role: boardMembers.role, pinned: boardMembers.pinned, targetClientId: users.clientId })
      .from(boardMembers)
      .innerJoin(boards, eq(boards.id, boardMembers.boardId))
      .innerJoin(users, eq(users.id, boardMembers.userId))
      .where(and(eq(boards.workspaceId, id), eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)))
      .limit(1);
    if (!member) throw notFound();
    // This route has guest-seat side effects and must never bypass the pinned-admin protections on
    // the general board-members endpoint for a same-organisation user.
    if (member.targetClientId === clientId || member.pinned) throw badRequest("target is not a removable board guest");
    const cleanup = await db.transaction(async (tx) => {
      const participation = await cleanupUserBoardParticipation(tx, {
        userId,
        boardIds: [boardId],
        actorId: req.auth.sub,
      });
      await recordActivity(tx, {
        boardId,
        workspaceId: id,
        actorId: req.auth.sub,
        entityType: "board",
        entityId: userId,
        action: "removed",
        payload: { userId, role: member.role },
      });
      return participation;
    });
    // Frees the guest's pooled seat (used count) without reducing the purchased seat_limit / bill —
    // the freed seat stays available for the admin to assign to someone else.
    const guestSeat = await prunePaidGuestSeatIfBelowLimit({ hostClientId: clientId, userId });
    await emitToBoard(boardId, "board:member:removed", { boardId, userId });
    for (const update of cleanup.assigneeUpdates) await emitToBoard(boardId, "card:assignees:set", update);
    for (const update of cleanup.checklistItemUpdates) await emitToBoard(boardId, "card:checklistItem:updated", update);
    for (const update of cleanup.activities) await emitActivityFeedItem(update.boardId, update.cardId, update.activity, { notify: false });
    disconnectUserRealtimeSockets(userId);
    return reply.status(200).send({ paidGuestSeatRemoved: guestSeat.paidGuestSeatRemoved });
  });

  app.get("/home/boards", async (req) => {
    if (req.auth.authKind === "apiKey" && req.auth.apiKeyKind !== "personal") {
      const workspaceId = req.auth.apiKeyWorkspaceId!;
      await assertWorkspaceAccess(req.auth, workspaceId);
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
      if (!workspace) throw notFound("workspace not found");
      const workspaceBoards = await db
        .select()
        .from(boards)
        .where(and(eq(boards.workspaceId, workspaceId), isNull(boards.archivedAt)))
        .orderBy(asc(boards.position));
      const workspaceBoardGroups = await db
        .select()
        .from(boardGroups)
        .where(eq(boardGroups.workspaceId, workspaceId))
        .orderBy(asc(boardGroups.position));
      const members = await db
        .select({
          userId: workspaceMembers.userId,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          lastOnlineAt: users.lastOnlineAt,
          role: workspaceMembers.role,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, workspaceId));
      return {
        groups: [{
          workspace: {
            ...workspace,
            role: req.auth.apiKeyScope === "admin" ? "admin" : "member",
          },
          boardGroups: workspaceBoardGroups,
          boards: workspaceBoards.map((board) => ({
            ...board,
            myCards: 0,
            myOverdue: 0,
          })),
          members: members.map((member) => withSignedMedia(req.auth.cid, member)),
        }],
        dueSoon: [],
      };
    }

    const orgAdmin = isOrgAdmin(req.auth);
    const userId = req.auth.sub;
    const rows = orgAdmin
      ? await db
        .select({
          workspace: workspaces,
          role: sql<"admin">`'admin'::workspace_role`.as("role"),
          board: boards,
          explicitMemberId: sql<string | null>`null::uuid`.as("explicit_member_id"),
        })
        .from(workspaces)
        .leftJoin(boards, and(eq(boards.workspaceId, workspaces.id), isNull(boards.archivedAt)))
        .where(eq(workspaces.clientId, req.auth.cid))
        .orderBy(asc(workspaces.createdAt), asc(boards.position))
      : await db
        .select({
          workspace: workspaces,
          role: workspaceMembers.role,
          board: boards,
          explicitMemberId: boardMembers.userId,
        })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .leftJoin(boards, and(eq(boards.workspaceId, workspaces.id), isNull(boards.archivedAt)))
        .leftJoin(boardMembers, and(eq(boardMembers.boardId, boards.id), eq(boardMembers.userId, userId)))
        .where(eq(workspaceMembers.userId, userId))
        .orderBy(asc(workspaces.createdAt), asc(boards.position));

    type BoardWithStats = {
      id: string;
      workspaceId: string;
      name: string;
      icon: string | null;
      iconColor: string | null;
      backgroundGradient: string | null;
      groupId: string | null;
      position: string;
      myCards: number;
      myOverdue: number;
    };
    type Member = { userId: string; displayName: string; avatarUrl: string | null; lastOnlineAt: Date | null; role: "admin" | "member" };
    type BoardGroup = { id: string; workspaceId: string; title: string; position: string; createdAt: Date; updatedAt: Date };
    type HomeGroup = { workspace: unknown; boardGroups: BoardGroup[]; boards: BoardWithStats[]; members: Member[] };
    const grouped = new Map<string, HomeGroup>();
    const boardIds: string[] = [];
    for (const row of rows) {
      const workspace = { ...row.workspace, role: row.role };
      if (!grouped.has(row.workspace.id)) grouped.set(row.workspace.id, { workspace, boardGroups: [], boards: [], members: [] });
      // Board membership is the access model: a workspace member sees a board on their home/sidebar
      // only if they hold an explicit board_member row (org admins see every board implicitly).
      if (row.board && (orgAdmin || row.explicitMemberId)) {
        grouped.get(row.workspace.id)!.boards.push({
          id: row.board.id,
          workspaceId: row.board.workspaceId,
          name: row.board.name,
          icon: row.board.icon,
          iconColor: row.board.iconColor,
          backgroundGradient: row.board.backgroundGradient,
          groupId: row.board.groupId,
          position: row.board.position,
          myCards: 0,
          myOverdue: 0,
        });
        boardIds.push(row.board.id);
      }
    }

    const workspaceIds = [...grouped.keys()];

    if (workspaceIds.length > 0) {
      const [boardGroupRows, memberRows, statsRows] = await Promise.all([
        db
          .select()
          .from(boardGroups)
          .where(inArray(boardGroups.workspaceId, workspaceIds))
          .orderBy(asc(boardGroups.position)),

        db
          .select({
            workspaceId: workspaceMembers.workspaceId,
            userId: workspaceMembers.userId,
            role: workspaceMembers.role,
            displayName: users.displayName,
            avatarUrl: users.avatarUrl,
            lastOnlineAt: users.lastOnlineAt,
          })
          .from(workspaceMembers)
          .innerJoin(users, eq(users.id, workspaceMembers.userId))
          .where(inArray(workspaceMembers.workspaceId, workspaceIds))
          .orderBy(asc(users.displayName)),

        // Per-board stats: cards assigned to current user and overdue.
        boardIds.length > 0
          ? db
            .select({
              boardId: cards.boardId,
              completedAt: cards.completedAt,
              dueDateLocalDate: cards.dueDateLocalDate,
              dueDateSlot: cards.dueDateSlot,
              dueDateTimezone: cards.dueDateTimezone,
            })
            .from(cardAssignees)
            .innerJoin(cards, and(eq(cards.id, cardAssignees.cardId), isNull(cards.archivedAt)))
            .where(and(eq(cardAssignees.userId, userId), inArray(cards.boardId, boardIds)))
          : Promise.resolve([]),
      ]);

      for (const row of boardGroupRows) {
        grouped.get(row.workspaceId)?.boardGroups.push(row);
      }

      for (const row of memberRows) {
        const group = grouped.get(row.workspaceId);
        if (!group) continue;
        const shaped = withSignedMedia(req.auth.cid, {
          userId: row.userId,
          displayName: row.displayName,
          avatarUrl: row.avatarUrl,
          lastOnlineAt: row.lastOnlineAt,
          role: row.role,
        });
        group.members.push(shaped);
      }

      const statsMap = new Map<string, { myCards: number; myOverdue: number }>();
      for (const row of statsRows) {
        const stats = statsMap.get(row.boardId) ?? { myCards: 0, myOverdue: 0 };
        stats.myCards += 1;
        if (!row.completedAt && isDueDateOverdue(row)) stats.myOverdue += 1;
        statsMap.set(row.boardId, stats);
      }
      for (const group of grouped.values()) {
        for (const board of group.boards) {
          const stats = statsMap.get(board.id);
          if (stats) {
            board.myCards = stats.myCards;
            board.myOverdue = stats.myOverdue;
          }
        }
      }
    }

    const groups = [...grouped.values()];

    // Guest boards: boards in other orgs where the user has an explicit board_members entry.
    type GuestHomeGroup = {
      workspace: unknown;
      clientName: string;
      boardGroups: BoardGroup[];
      boards: BoardWithStats[];
    };
    const guestGrouped = new Map<string, GuestHomeGroup>();
    const guestBoardIds: string[] = [];

    {
      const guestRows = await db
        .select({
          workspace: workspaces,
          clientName: clients.name,
          board: boards,
          boardRole: boardMembers.role,
        })
        .from(boardMembers)
        .innerJoin(boards, and(eq(boards.id, boardMembers.boardId), isNull(boards.archivedAt)))
        .innerJoin(
          workspaces,
          and(eq(workspaces.id, boards.workspaceId), ne(workspaces.clientId, req.auth.cid)),
        )
        .innerJoin(clients, eq(clients.id, workspaces.clientId))
        .where(eq(boardMembers.userId, userId))
        .orderBy(asc(workspaces.createdAt), asc(boards.position));

      for (const row of guestRows) {
        const workspace = { ...row.workspace, role: row.boardRole };
        if (!guestGrouped.has(row.workspace.id)) {
          guestGrouped.set(row.workspace.id, {
            workspace,
            clientName: row.clientName,
            boardGroups: [],
            boards: [],
          });
        }
        guestGrouped.get(row.workspace.id)!.boards.push({
          id: row.board.id,
          workspaceId: row.board.workspaceId,
          name: row.board.name,
          icon: row.board.icon,
          iconColor: row.board.iconColor,
          backgroundGradient: row.board.backgroundGradient,
          groupId: row.board.groupId,
          position: row.board.position,
          myCards: 0,
          myOverdue: 0,
        });
        guestBoardIds.push(row.board.id);
      }

      if (guestBoardIds.length > 0) {
        const guestWorkspaceIds = [...guestGrouped.keys()];
        const [guestBoardGroupRows, guestStatsRows] = await Promise.all([
          db
            .select()
            .from(boardGroups)
            .where(inArray(boardGroups.workspaceId, guestWorkspaceIds))
            .orderBy(asc(boardGroups.position)),
          db
            .select({
              boardId: cards.boardId,
              completedAt: cards.completedAt,
              dueDateLocalDate: cards.dueDateLocalDate,
              dueDateSlot: cards.dueDateSlot,
              dueDateTimezone: cards.dueDateTimezone,
            })
            .from(cardAssignees)
            .innerJoin(cards, and(eq(cards.id, cardAssignees.cardId), isNull(cards.archivedAt)))
            .where(and(eq(cardAssignees.userId, userId), inArray(cards.boardId, guestBoardIds))),
        ]);

        for (const row of guestBoardGroupRows) {
          guestGrouped.get(row.workspaceId)?.boardGroups.push(row);
        }

        const guestStatsMap = new Map<string, { myCards: number; myOverdue: number }>();
        for (const row of guestStatsRows) {
          const stats = guestStatsMap.get(row.boardId) ?? { myCards: 0, myOverdue: 0 };
          stats.myCards += 1;
          if (!row.completedAt && isDueDateOverdue(row)) stats.myOverdue += 1;
          guestStatsMap.set(row.boardId, stats);
        }
        for (const group of guestGrouped.values()) {
          for (const board of group.boards) {
            const stats = guestStatsMap.get(board.id);
            if (stats) {
              board.myCards = stats.myCards;
              board.myOverdue = stats.myOverdue;
            }
          }
        }
      }
    }

    const guestGroups = [...guestGrouped.values()];

    type DueSoonCard = {
      // "card" rows carry the card id in `id`; "checklistItem" rows carry the item id in `id`
      // (unique track key) and the parent card id in `cardId` for deep-linking.
      kind: "card" | "checklistItem";
      id: string;
      cardId?: string;
      cardTitle?: string;
      itemText?: string;
      boardId: string;
      workspaceId: string;
      title: string;
      boardName: string;
      boardIcon: string | null;
      dueDateLocalDate: string;
      dueDateSlot: "anyTime" | "morning" | "afternoon" | "endOfWorkDay" | null;
      dueDateTimezone: string | null;
    };
    const accessibleDueBoardIds = [...new Set([...boardIds, ...guestBoardIds])];
    let dueSoon: DueSoonCard[] = [];
    let overdueChecklistItems = 0;
    if (accessibleDueBoardIds.length > 0) {
      const [userRow] = await db
        .select({ timezone: users.timezone })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const today = localDateInTimezone(new Date(), userRow?.timezone ?? "UTC");
      const tomorrow = addDays(today, 1);
      const [dueRows, assignedChecklistItems] = await Promise.all([
        db
          .select({
            id: cards.id,
            boardId: cards.boardId,
            workspaceId: boards.workspaceId,
            title: cards.title,
            boardName: boards.name,
            boardIcon: boards.icon,
            dueDateLocalDate: cards.dueDateLocalDate,
            dueDateSlot: cards.dueDateSlot,
            dueDateTimezone: cards.dueDateTimezone,
          })
          .from(cardAssignees)
          .innerJoin(cards, and(eq(cards.id, cardAssignees.cardId), isNull(cards.archivedAt), isNull(cards.completedAt)))
          .innerJoin(boards, eq(boards.id, cards.boardId))
          .where(and(
            eq(cardAssignees.userId, userId),
            inArray(cards.boardId, accessibleDueBoardIds),
            inArray(cards.dueDateLocalDate, [today, tomorrow]),
          )),
        // All assigned, due-dated, active checklist items on accessible boards. We derive both
        // the due-soon (today/tomorrow) entries and the overdue chip count from this one query.
        loadAssignedChecklistItems(db, { assigneeIds: [userId], boardIds: accessibleDueBoardIds }),
      ]);

      const cardDueSoon: DueSoonCard[] = dueRows.flatMap((row) =>
        row.dueDateLocalDate ? [{ kind: "card" as const, ...row, dueDateLocalDate: row.dueDateLocalDate }] : [],
      );
      const checklistDueSoon: DueSoonCard[] = assignedChecklistItems.flatMap((item) =>
        item.dueDateLocalDate && (item.dueDateLocalDate === today || item.dueDateLocalDate === tomorrow)
          ? [{
              kind: "checklistItem" as const,
              id: item.itemId,
              cardId: item.cardId,
              cardTitle: item.cardTitle,
              itemText: item.text,
              boardId: item.boardId,
              workspaceId: item.workspaceId,
              title: item.text,
              boardName: item.boardName,
              boardIcon: item.boardIcon,
              dueDateLocalDate: item.dueDateLocalDate,
              dueDateSlot: item.dueDateSlot,
              dueDateTimezone: item.dueDateTimezone,
            }]
          : [],
      );
      // Overdue checklist items feed the dedicated chip count, not the due-soon list (which,
      // like cards, only shows today/tomorrow). isDueDateOverdue is the single source of truth.
      overdueChecklistItems = assignedChecklistItems.filter((item) => isDueDateOverdue(item)).length;

      dueSoon = [...cardDueSoon, ...checklistDueSoon];
      const slotRank = { morning: 0, afternoon: 1, endOfWorkDay: 2, anyTime: 3 } as const;
      dueSoon.sort((a, b) =>
        a.dueDateLocalDate.localeCompare(b.dueDateLocalDate) ||
        (slotRank[a.dueDateSlot ?? "anyTime"] - slotRank[b.dueDateSlot ?? "anyTime"]) ||
        a.boardName.localeCompare(b.boardName) ||
        a.title.localeCompare(b.title)
      );
    }

    return { groups, guestGroups, dueSoon, overdueChecklistItems };
  });
}
