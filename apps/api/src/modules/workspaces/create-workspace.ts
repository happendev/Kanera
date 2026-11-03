import type { ColorToken } from "@kanera/shared/colors";
import type { CreateWorkspaceBody } from "@kanera/shared/dto";
import { isKnownTimeZone } from "@kanera/shared/time-in-progress";
import { DEFAULT_WORKSPACE_CUSTOM_FIELDS, DEFAULT_WORKSPACE_LABELS, DEFAULT_WORKSPACE_LISTS } from "@kanera/shared/workspace-templates";
import { automationActions, automations, boards, cardLabelAssignments, cardLabels, cards, checklistTemplateItems, checklistTemplates, clients, customFieldOptions, customFields, lists, users, workspaceMembers, workspaces, type AutomationActionConfig } from "@kanera/shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { evaluateWorkspaceAnalyticsMilestones } from "../../lib/analytics-milestones.js";
import { recordActivity } from "../../lib/activity.js";
import { applyChecklistTemplates } from "../../lib/checklist-templates.js";
import { seedBoardMembersFromWorkspace } from "../../lib/board-membership.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { allocateCardKeys, reserveCardKeyPrefix } from "../../lib/card-keys.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { ANALYTICS_EVENT_VERSION, analyticsPlanCode, capturePremiumFeatureUsed, productAnalytics } from "../../lib/product-analytics.js";
import { assertBoardLimit, shouldEnableSeededAutomations } from "../../lib/tier-limits.js";
import { emitToBoardAudience, emitToUser } from "../../realtime/emit.js";
import { positionAtIndex } from "../../lib/position.js";

interface CreateWorkspaceParams {
  auth: AuthClaims;
  body: CreateWorkspaceBody;
}

type CreateWorkspaceResult = Awaited<ReturnType<typeof createWorkspace>>;

export async function createWorkspace({ auth, body }: CreateWorkspaceParams) {
  return db.transaction(async (tx) => {
    const workspaceId = randomUUID();
    const workspaceName = body.kind === "board" ? body.initialBoard!.name : body.name;
    const cardKeyPrefix = await reserveCardKeyPrefix(tx, {
      clientId: auth.cid,
      workspaceId,
      workspaceName,
      requestedPrefix: body.cardKeyPrefix,
    });
    // Time in progress counts working hours in this zone; the creator's is the best default there is.
    const [creator] = await tx.select({ timezone: users.timezone }).from(users).where(eq(users.id, auth.sub)).limit(1);
    const [organisationDefaults] = await tx
      .select({
        completedCardsActiveDays: clients.defaultCompletedCardsActiveDays,
        inactiveCardsDays: clients.defaultInactiveCardsDays,
      })
      .from(clients)
      .where(eq(clients.id, auth.cid))
      .limit(1);
    if (!organisationDefaults) throw notFound("organisation not found");
    const [workspace] = await tx
      .insert(workspaces)
      .values({
        id: workspaceId,
        clientId: auth.cid,
        name: workspaceName,
        cardKeyPrefix,
        kind: body.kind,
        // Standalone identity is mirrored at birth as well as on later PATCHes. Advanced API
        // callers cannot create a hidden workspace whose icon or color disagrees with its board.
        icon: body.kind === "board" ? body.initialBoard!.icon ?? null : body.icon ?? null,
        accentColor: body.kind === "board" ? body.initialBoard!.iconColor ?? null : null,
        // Defaults are copied at creation so each workspace can diverge later without an
        // organisation-level change silently rewriting existing board behaviour.
        completedCardsActiveDays: organisationDefaults.completedCardsActiveDays,
        inactiveCardsDays: organisationDefaults.inactiveCardsDays,
        timeZone: body.timeZone ?? (creator?.timezone && isKnownTimeZone(creator.timezone) ? creator.timezone : "UTC"),
      })
      .returning();
    const [member] = await tx.insert(workspaceMembers).values({
      workspaceId: workspace!.id,
      userId: auth.sub,
      role: "admin",
    }).returning();
    if (!member) throw badRequest("could not add workspace member");

    // Bare `listNames` carry no classification, so only the default workflow (and explicit
    // `lists`) arrive with in-progress flags; admins can flag lists later in settings.
    const initialLists: { name: string; icon?: string | null; color?: ColorToken | null; inProgress?: boolean }[] =
      body.lists ?? (body.listNames ? body.listNames.map((name) => ({ name })) : [...DEFAULT_WORKSPACE_LISTS]);
    // Blank onboarding intentionally sends an explicit empty list array so users can configure
    // workspace lists later. Omitted lists still seed the default workflow above.
    const initialListRows = initialLists.length > 0
      ? await tx.insert(lists).values(
        initialLists.map((list, index) => ({
          workspaceId: workspace!.id,
          name: list.name,
          icon: "icon" in list ? list.icon ?? null : null,
          color: list.color ?? null,
          inProgress: list.inProgress ?? false,
          position: positionAtIndex(index),
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
          position: positionAtIndex(index),
        })),
      ).returning()
      : [];
    const initialCustomFieldOptions = initialCustomFields.flatMap((field, fieldIndex) =>
        field.type === "select"
          ? ("options" in field ? field.options ?? [] : []).map((option, optionIndex) => ({
              fieldId: initialCustomFieldRows[fieldIndex]!.id,
              label: option.label,
              color: option.color ?? null,
              position: positionAtIndex(optionIndex),
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
          position: positionAtIndex(index),
        })),
      ).returning()
      : [];

    const initialChecklistTemplateRows = body.checklistTemplates?.length
      ? await tx.insert(checklistTemplates).values(
        body.checklistTemplates.map((template, index) => ({
          workspaceId: workspace!.id,
          title: template.title,
          position: positionAtIndex(index),
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
      const enabled = await shouldEnableSeededAutomations(auth.cid, tx);
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
          actorId: auth.sub,
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
      await assertBoardLimit(auth.cid, tx);
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
      await seedBoardMembersFromWorkspace(tx, board!.id, workspace!.id, auth.sub);

      await recordActivity(tx, {
        boardId: board!.id,
        workspaceId: workspace!.id,
        actorId: auth.sub,
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

        const starterCardIdentities = await allocateCardKeys(tx, workspace!.id, body.cards.length);
        for (const [starterCardIndex, starterCard] of body.cards.entries()) {
          const list = listByName.get(normalizeSeedName(starterCard.listName));
          if (!list) throw badRequest(`starter card list not found: ${starterCard.listName}`);
          const listCardIndex = cardCountByList.get(list.id) ?? 0;
          cardCountByList.set(list.id, listCardIndex + 1);
          const [card] = await tx.insert(cards).values({
            ...starterCardIdentities[starterCardIndex]!,
            boardId: board!.id,
            listId: list.id,
            title: starterCard.title,
            description: starterCard.description,
            position: String((listCardIndex + 1) * 1000),
            createdById: auth.sub,
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
            actorId: auth.sub,
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
              actorId: auth.sub,
              templateIds: checklistTemplateIds,
            });
          }
        }
      }

      createdInitialBoard = board!;
    }

    return { workspace: workspace!, creatorMembership: member, initialBoard: createdInitialBoard };
  });
}

export async function emitCreateWorkspace({ auth, workspace: ws, creatorMembership, initialBoard }: CreateWorkspaceResult & { auth: AuthClaims }) {
  const [creator] = await db
    .select({ email: users.email, displayName: users.displayName, avatarUrl: users.avatarUrl, lastOnlineAt: users.lastOnlineAt, homeClientId: users.clientId })
    .from(users)
    .where(eq(users.id, auth.sub))
    .limit(1);
  // The creator's other tabs were not in workspace:${ws.id} when the workspace-scoped events
  // fired. Send the membership event directly so they join the room and refresh the home model.
  emitToUser(auth.sub, "workspace:member:added", {
    workspaceId: ws.id,
    member: withSignedMedia(creator?.homeClientId ?? auth.cid, {
      ...creatorMembership,
      email: creator?.email,
      displayName: creator?.displayName,
      avatarUrl: creator?.avatarUrl,
      lastOnlineAt: creator?.lastOnlineAt,
    }),
  });
  if (initialBoard) void emitToBoardAudience(initialBoard.id, "board:created", { workspaceId: ws.id, board: initialBoard }, { workspaceId: ws.id });
  const supportSession = auth.authKind === "support";
  const [analyticsClient] = await db
    .select({ billingStatus: clients.billingStatus })
    .from(clients)
    .where(eq(clients.id, auth.cid))
    .limit(1);
  void productAnalytics.capture({
    event: "workspace_created",
    distinctId: auth.sub,
    organizationId: auth.cid,
    supportSession,
    properties: {
      user_id: auth.sub,
      workspace_id: ws.id,
      plan_code: analyticsPlanCode(analyticsClient?.billingStatus ?? "none"),
      event_version: ANALYTICS_EVENT_VERSION,
    },
  });
  if (initialBoard) {
    void productAnalytics.capture({
      event: "board_created",
      distinctId: auth.sub,
      organizationId: auth.cid,
      supportSession,
      properties: {
        user_id: auth.sub,
        workspace_id: ws.id,
        board_count_band: "1",
        event_version: ANALYTICS_EVENT_VERSION,
      },
    });
    const [organizationBoardCount] = await db.select({ count: sql<number>`count(*)::int` })
      .from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(eq(workspaces.clientId, auth.cid), isNull(workspaces.archivedAt), isNull(boards.archivedAt)));
    const totalBoards = organizationBoardCount?.count ?? 1;
    if (totalBoards > env.HOSTED_FREE_MAX_BOARDS) void capturePremiumFeatureUsed({
      organizationId: auth.cid,
      workspaceId: ws.id,
      actorId: auth.sub,
      premiumFeature: "boards",
      currentUsage: totalBoards,
      supportSession,
    });
    await evaluateWorkspaceAnalyticsMilestones({ workspaceId: ws.id, actorId: auth.sub, supportSession });
  }
}
