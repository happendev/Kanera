import { Injectable, inject } from "@angular/core";
import { CLIENT_EVENTS, expandWireCard, SERVER_EVENTS, type ServerToClientEvents, type WireCardChecklistItem, type WireCardDetail, type WireCardSummary, type WireChecklistAssignment } from "@kanera/shared/events";
import { registerSocketHandlers } from "../../core/realtime/socket-handlers";
import { ApiClient } from "../../core/api/api.client";
import { SocketService, type AppSocket } from "../../core/realtime/socket.service";
import { AssignedWorkState } from "./assigned-work-state";

export type AttachOptions = {
  onJoined?: () => void;
  onDesync?: () => void;
  onWorkDoneChanged?: () => void;
};

@Injectable()
export class AssignedWorkSocketBridge {
  private readonly state = inject(AssignedWorkState);
  private readonly api = inject(ApiClient);
  private readonly sockets = inject(SocketService);

  // Subscribe to workspace-scoped events for the assigned-work workspace plus card events
  // for every accessible board. Card events are filtered to the cards we're tracking, and
  // card:assignees:set deltas drive add/remove based on the target user.
  attach(socket: AppSocket, workspaceId: string, options: AttachOptions = {}) {
    const state = this.state;
    const isCurrentWorkspace = (id: string) => id === workspaceId;
    const leaveWorkspace = this.sockets.joinWorkspace(workspaceId);
    let refreshQueued = false;
    const queueAssignedWorkRefresh = () => {
      if (refreshQueued) return;
      refreshQueued = true;
      queueMicrotask(() => {
        refreshQueued = false;
        options.onDesync?.();
      });
    };

    // Track join state per-board so we know which boards to (re)join on reconnect.
    const currentBoardIds = () => state.boards().map((b) => b.id);
    const joinAllBoards = () => {
      const boardIds = currentBoardIds();
      if (!boardIds.length) {
        options.onJoined?.();
        return;
      }
      let pending = boardIds.length;
      let joinedAny = false;
      const finishJoin = () => {
        pending -= 1;
        if (pending === 0 && joinedAny) options.onJoined?.();
      };
      for (const id of boardIds) {
        socket.emit(CLIENT_EVENTS.BOARD_JOIN, id, (ok) => {
          if (!ok) console.warn("board:join rejected", id);
          else joinedAny = true;
          finishJoin();
        });
      }
    };

    const targetUserId = () => state.targetUser()?.userId;
    const isCurrentTargetUser = (id: string) => {
      const target = targetUserId();
      return Boolean(target && target !== "all" && target === id);
    };

    // Build a checklist work item from a realtime event. The event carries the parent card title;
    // board name/icon come from the consumer's own board list, so no follow-up fetch is needed.
    const buildChecklistAssignment = (boardId: string, cardId: string, cardTitle: string, listId: string, item: WireCardChecklistItem): WireChecklistAssignment | null => {
      const board = state.boardsById().get(boardId);
      if (!board || !item.assigneeId) return null;
      return {
        itemId: item.id,
        text: item.text,
        cardId,
        cardTitle,
        checklistId: item.checklistId,
        listId,
        boardId,
        boardName: board.name,
        boardIcon: board.icon,
        assigneeId: item.assigneeId,
        dueDateLocalDate: item.dueDateLocalDate,
        dueDateSlot: item.dueDateSlot,
        dueDateTimezone: item.dueDateTimezone,
      };
    };
    const refreshCard = async (cardId: string) => {
      try {
        const detail = await this.api.get<WireCardDetail>(`/cards/${cardId}/detail`);
        const target = targetUserId();
        if (!target || !detail.assigneeIds.includes(target)) {
          state.removeCard(cardId);
          return;
        }
        if (!state.isBoardVisible(detail.card.boardId)) {
          state.removeCard(cardId);
          return;
        }
        const card = detail.card;
        const summary: WireCardSummary = {
          id: card.id,
          listId: card.listId,
          boardId: card.boardId,
          title: card.title,
          position: card.position,
          dueDateLocalDate: card.dueDateLocalDate,
          dueDateSlot: card.dueDateSlot,
          dueDateTimezone: card.dueDateTimezone,
          completedAt: card.completedAt,
          archivedAt: card.archivedAt,
          coverAttachmentId: card.coverAttachmentId,
          createdAt: card.createdAt,
          updatedAt: card.updatedAt,
          hasDescription: Boolean(card.description),
          commentCount: state.commentCountForCard(cardId),
          attachmentCount: detail.attachments.length,
          checklistDoneCount: detail.checklists.reduce((sum, checklist) => sum + checklist.items.filter((item) => item.completedAt).length, 0),
          checklistTotalCount: detail.checklists.reduce((sum, checklist) => sum + checklist.items.length, 0),
          coverUrl: null,
          labelIds: detail.labelIds,
          assigneeIds: detail.assigneeIds,
          customFieldValues: detail.customFieldValues,
        };
        state.upsertCardSummary(summary);
      } catch {
        // If the fetch fails (e.g., we lost access) fall back to removing the card
        // so the view doesn't show something the viewer can no longer reach.
        state.removeCard(cardId);
      }
    };

    const handlers: Partial<ServerToClientEvents> = {
      // Workspace-scoped events: filter by workspace id.
      [SERVER_EVENTS.LIST_CREATED]: ({ workspaceId: ws, list }) => {
        if (!isCurrentWorkspace(ws)) return;
        state.lists.update((ls) => [...ls.filter((l) => l.id !== list.id), list]);
      },
      [SERVER_EVENTS.LIST_UPDATED]: ({ workspaceId: ws, list }) => {
        if (!isCurrentWorkspace(ws)) return;
        state.lists.update((ls) => ls.map((l) => (l.id === list.id ? list : l)));
      },
      [SERVER_EVENTS.LIST_MOVED]: ({ workspaceId: ws, listId, position }) => {
        if (!isCurrentWorkspace(ws)) return;
        state.lists.update((ls) => ls.map((l) => (l.id === listId ? { ...l, position } : l)));
      },
      [SERVER_EVENTS.LIST_REBALANCED]: ({ workspaceId: ws, positions }) => {
        if (!isCurrentWorkspace(ws)) return;
        const positionsById = new Map(positions.map((p) => [p.id, p.position]));
        state.lists.update((ls) =>
          ls.map((l) => {
            const position = positionsById.get(l.id);
            return position ? { ...l, position } : l;
          }),
        );
      },
      [SERVER_EVENTS.LIST_DELETED]: ({ workspaceId: ws, listId }) => {
        if (!isCurrentWorkspace(ws)) return;
        state.lists.update((ls) => ls.filter((l) => l.id !== listId));
      },
      [SERVER_EVENTS.CUSTOM_FIELD_CREATED]: ({ workspaceId: ws, customField }) => {
        if (!isCurrentWorkspace(ws)) return;
        state.customFields.update((fs) => state.sortCustomFields([...fs.filter((f) => f.id !== customField.id), customField]));
      },
      [SERVER_EVENTS.CUSTOM_FIELD_UPDATED]: ({ workspaceId: ws, customField }) => {
        if (!isCurrentWorkspace(ws)) return;
        state.customFields.update((fs) => state.sortCustomFields(fs.map((f) => (f.id === customField.id ? customField : f))));
      },
      [SERVER_EVENTS.CUSTOM_FIELD_MOVED]: ({ workspaceId: ws, fieldId, position }) => {
        if (!isCurrentWorkspace(ws)) return;
        state.customFields.update((fs) => state.sortCustomFields(fs.map((f) => (f.id === fieldId ? { ...f, position } : f))));
      },
      [SERVER_EVENTS.CUSTOM_FIELD_REBALANCED]: ({ workspaceId: ws, positions }) => {
        if (!isCurrentWorkspace(ws)) return;
        const positionsById = new Map(positions.map((p) => [p.id, p.position]));
        state.customFields.update((fs) =>
          state.sortCustomFields(
            fs.map((f) => {
              const position = positionsById.get(f.id);
              return position ? { ...f, position } : f;
            }),
          ),
        );
      },
      [SERVER_EVENTS.CUSTOM_FIELD_DELETED]: ({ workspaceId: ws, fieldId }) => {
        if (!isCurrentWorkspace(ws)) return;
        state.customFields.update((fs) => fs.filter((f) => f.id !== fieldId));
        state.customFieldValues.update((vs) => vs.filter((v) => v.fieldId !== fieldId));
      },
      [SERVER_EVENTS.CUSTOM_FIELD_OPTION_CREATED]: ({ workspaceId: ws, fieldId, option }) => {
        if (!isCurrentWorkspace(ws)) return;
        state.updateFieldOptions(fieldId, (options) => [...options.filter((o) => o.id !== option.id), option]);
      },
      [SERVER_EVENTS.CUSTOM_FIELD_OPTION_UPDATED]: ({ workspaceId: ws, fieldId, option }) => {
        if (!isCurrentWorkspace(ws)) return;
        state.updateFieldOptions(fieldId, (options) => options.map((o) => (o.id === option.id ? option : o)));
      },
      [SERVER_EVENTS.CUSTOM_FIELD_OPTION_MOVED]: ({ workspaceId: ws, fieldId, optionId, position }) => {
        if (!isCurrentWorkspace(ws)) return;
        state.updateFieldOptions(fieldId, (options) => options.map((o) => (o.id === optionId ? { ...o, position } : o)));
      },
      [SERVER_EVENTS.CUSTOM_FIELD_OPTION_REBALANCED]: ({ workspaceId: ws, fieldId, positions }) => {
        if (!isCurrentWorkspace(ws)) return;
        const positionsById = new Map(positions.map((p) => [p.id, p.position]));
        state.updateFieldOptions(fieldId, (options) =>
          options.map((o) => {
            const position = positionsById.get(o.id);
            return position ? { ...o, position } : o;
          }),
        );
      },
      [SERVER_EVENTS.CUSTOM_FIELD_OPTION_DELETED]: ({ workspaceId: ws, fieldId, optionId }) => {
        if (!isCurrentWorkspace(ws)) return;
        state.updateFieldOptions(fieldId, (options) => options.filter((o) => o.id !== optionId));
      },
      [SERVER_EVENTS.CARD_LABEL_CREATED]: ({ workspaceId: ws, cardLabel }) => {
        if (!isCurrentWorkspace(ws)) return;
        state.cardLabels.update((ls) => [...ls.filter((l) => l.id !== cardLabel.id), cardLabel]);
      },
      [SERVER_EVENTS.CARD_LABEL_UPDATED]: ({ workspaceId: ws, cardLabel }) => {
        if (!isCurrentWorkspace(ws)) return;
        state.cardLabels.update((ls) => ls.map((l) => (l.id === cardLabel.id ? cardLabel : l)));
      },
      [SERVER_EVENTS.CARD_LABEL_MOVED]: ({ workspaceId: ws, labelId, position }) => {
        if (!isCurrentWorkspace(ws)) return;
        state.cardLabels.update((ls) => ls.map((l) => (l.id === labelId ? { ...l, position } : l)));
      },
      [SERVER_EVENTS.CARD_LABEL_REBALANCED]: ({ workspaceId: ws, positions }) => {
        if (!isCurrentWorkspace(ws)) return;
        const positionsById = new Map(positions.map((p) => [p.id, p.position]));
        state.cardLabels.update((ls) =>
          ls.map((l) => {
            const position = positionsById.get(l.id);
            return position ? { ...l, position } : l;
          }),
        );
      },
      [SERVER_EVENTS.CARD_LABEL_DELETED]: ({ workspaceId: ws, labelId }) => {
        if (!isCurrentWorkspace(ws)) return;
        state.cardLabels.update((ls) => ls.filter((l) => l.id !== labelId));
      },

      // Card events from any joined board. We only act on cards already in state, except
      // for card:assignees:set which may add or remove a card from the view.
      [SERVER_EVENTS.CARD_UPDATED]: ({ boardId, card }) => {
        if (!state.isBoardVisible(boardId)) return;
        if (state.hasCard(card.id)) state.updateCard(expandWireCard(card));
        options.onWorkDoneChanged?.();
        queueAssignedWorkRefresh();
      },
      [SERVER_EVENTS.CARD_MOVED]: ({ boardId, cardId, toListId, position }) => {
        if (!state.isBoardVisible(boardId)) return;
        if (!state.hasCard(cardId)) return;
        if (!state.lists().some((l) => l.id === toListId)) {
          options.onDesync?.();
          return;
        }
        state.moveCard(cardId, toListId, position);
      },
      [SERVER_EVENTS.CARD_REBALANCED]: ({ boardId, positions }) => {
        if (!state.isBoardVisible(boardId)) return;
        // Rebalance payloads are per-board, but Assigned Work may not have every
        // card on that board loaded. BoardState updates known ids and ignores the rest.
        state.rebalanceCards(positions);
      },
      [SERVER_EVENTS.CARD_DELETED]: ({ boardId, cardId }) => {
        if (!state.isBoardVisible(boardId)) return;
        state.removeCard(cardId);
      },
      [SERVER_EVENTS.ASSIGNED_WORK_SEPARATOR_CREATED]: ({ workspaceId: ws, targetUserId: userId, separator }) => {
        if (!isCurrentWorkspace(ws) || !isCurrentTargetUser(userId)) return;
        state.addSeparator(separator);
      },
      [SERVER_EVENTS.ASSIGNED_WORK_SEPARATOR_UPDATED]: ({ workspaceId: ws, targetUserId: userId, separator }) => {
        if (!isCurrentWorkspace(ws) || !isCurrentTargetUser(userId)) return;
        state.updateSeparator(separator);
      },
      [SERVER_EVENTS.ASSIGNED_WORK_SEPARATOR_MOVED]: ({ workspaceId: ws, targetUserId: userId, separatorId, toListId, position }) => {
        if (!isCurrentWorkspace(ws) || !isCurrentTargetUser(userId)) return;
        // If this personal separator isn't loaded yet (e.g. another client created/moved it while
        // we were on a stale payload), refetch instead of applying a position to a missing row.
        if (!state.separatorsById().has(separatorId)) {
          queueAssignedWorkRefresh();
          return;
        }
        state.moveSeparator(separatorId, toListId, position);
      },
      [SERVER_EVENTS.ASSIGNED_WORK_SEPARATOR_DELETED]: ({ workspaceId: ws, targetUserId: userId, separatorId }) => {
        if (!isCurrentWorkspace(ws) || !isCurrentTargetUser(userId)) return;
        state.removeSeparator(separatorId);
      },
      [SERVER_EVENTS.CARD_ASSIGNEES_SET]: ({ boardId, cardId, assigneeIds }) => {
        if (!state.isBoardVisible(boardId)) return;
        queueAssignedWorkRefresh();
        const target = targetUserId();
        if (!target) return;
        const inView = state.hasCard(cardId);
        const nowAssigned = assigneeIds.includes(target);
        if (inView && nowAssigned) {
          // Still relevant; just update local assignee state.
          state.setCardAssignees(cardId, assigneeIds);
        } else if (inView && !nowAssigned) {
          state.removeCard(cardId);
        } else if (!inView && nowAssigned) {
          void refreshCard(cardId);
        }
      },
      [SERVER_EVENTS.CARD_LABELS_SET]: ({ boardId, cardId, labelIds }) => {
        if (!state.isBoardVisible(boardId)) return;
        if (!state.hasCard(cardId)) return;
        state.cardLabelAssignments.update((as) => [
          ...as.filter((a) => a.cardId !== cardId),
          ...labelIds.map((labelId) => ({ cardId, labelId, assignedAt: new Date() })),
        ]);
      },
      [SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_SET]: ({ boardId, cardId, fieldId, valueText, valueNumber, valueCheckbox, valueDate, valueUrl, valueOptionIds, valueUserIds }) => {
        if (!state.isBoardVisible(boardId)) return;
        if (!state.hasCard(cardId)) return;
        state.customFieldValues.update((values) => {
          const next = {
            cardId,
            fieldId,
            valueText: valueText ?? null,
            valueNumber: valueNumber ?? null,
            valueCheckbox: valueCheckbox ?? null,
            valueDate: valueDate ?? null,
            valueUrl: valueUrl ?? null,
            valueOptionIds: valueOptionIds ?? null,
            valueUserIds: valueUserIds ?? null,
            updatedAt: new Date(),
          };
          const exists = values.some((v) => v.cardId === cardId && v.fieldId === fieldId);
          return exists ? values.map((v) => (v.cardId === cardId && v.fieldId === fieldId ? next : v)) : [...values, next];
        });
      },
      [SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_CLEARED]: ({ boardId, cardId, fieldId }) => {
        if (!state.isBoardVisible(boardId)) return;
        if (!state.hasCard(cardId)) return;
        state.customFieldValues.update((values) => values.filter((v) => v.cardId !== cardId || v.fieldId !== fieldId));
      },
      [SERVER_EVENTS.CARD_ATTACHMENT_CREATED]: ({ boardId, attachment }) => {
        if (!state.isBoardVisible(boardId)) return;
        if (!state.hasCard(attachment.cardId)) return;
        const isNew = !state.cardAttachments().some((a) => a.id === attachment.id);
        state.forgetAttachmentDelete(attachment.id);
        if (isNew) {
          state.incrementAttachmentCount(attachment.cardId);
        }
        state.cardAttachments.update((attachments) =>
          isNew ? [...attachments, attachment] : attachments.map((a) => (a.id === attachment.id ? attachment : a)),
        );
      },
      [SERVER_EVENTS.CARD_ATTACHMENT_DELETED]: ({ boardId, cardId, attachmentId }) => {
        if (!state.isBoardVisible(boardId)) return;
        if (!state.hasCard(cardId)) return;
        if (!state.tryMarkAttachmentDelete(attachmentId)) return;
        state.decrementAttachmentCount(cardId);
        state.cardAttachments.update((attachments) => attachments.filter((a) => a.id !== attachmentId));
      },
      [SERVER_EVENTS.CARD_CHECKLIST_CREATED]: ({ boardId, cardId, checklist }) => {
        if (!state.isBoardVisible(boardId) || !state.hasCard(cardId)) return;
        state.addChecklist(cardId, checklist);
      },
      [SERVER_EVENTS.CARD_CHECKLIST_UPDATED]: ({ boardId, cardId, checklist }) => {
        if (!state.isBoardVisible(boardId)) return;
        state.updateChecklist(cardId, checklist);
      },
      [SERVER_EVENTS.CARD_CHECKLIST_MOVED]: ({ boardId, cardId, checklistId, position }) => {
        if (!state.isBoardVisible(boardId)) return;
        state.moveChecklist(cardId, checklistId, position);
      },
      [SERVER_EVENTS.CARD_CHECKLIST_REBALANCED]: ({ boardId, cardId, positions }) => {
        if (!state.isBoardVisible(boardId)) return;
        for (const position of positions) state.moveChecklist(cardId, position.id, position.position);
      },
      [SERVER_EVENTS.CARD_CHECKLIST_DELETED]: ({ boardId, cardId, checklistId }) => {
        if (!state.isBoardVisible(boardId)) return;
        state.removeChecklist(cardId, checklistId);
      },
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_CREATED]: ({ boardId, cardId, cardTitle, listId, checklistId, checklistParentItemId, item }) => {
        if (!state.isBoardVisible(boardId)) return;
        // Per-card checklist substate only applies when the card is in the card grid.
        if (state.hasCard(cardId)) state.addChecklistItem(cardId, checklistId, item, checklistParentItemId);
        // The "My checklist items" list tracks by assignee, independent of card membership.
        if (item.assigneeId && item.assigneeId === targetUserId() && !item.completedAt) {
          const assignment = buildChecklistAssignment(boardId, cardId, cardTitle, listId, item);
          if (assignment) state.upsertAssignedChecklistItem(assignment);
        }
      },
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_UPDATED]: ({ boardId, cardId, cardTitle, listId, checklistId, checklistParentItemId, item, prevCompletedAt }) => {
        if (!state.isBoardVisible(boardId)) return;
        state.updateChecklistItem(cardId, checklistId, item, prevCompletedAt, checklistParentItemId);
        options.onWorkDoneChanged?.();
        // Maintain the assigned checklist list by assignee. Items can be relevant even when the
        // parent card is not in the card grid (checklist assignment no longer assigns the card).
        // The event carries enough context to add/update the entry without a refresh.
        const target = targetUserId();
        const relevant = !!target && item.assigneeId === target && !item.completedAt;
        if (relevant) {
          const assignment = buildChecklistAssignment(boardId, cardId, cardTitle, listId, item);
          if (assignment) state.upsertAssignedChecklistItem(assignment);
        } else {
          // Reassigned away or completed — drop it from the list (no-op if absent).
          state.removeAssignedChecklistItem(item.id);
        }
      },
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_MOVED]: ({ boardId, cardId, itemId, fromChecklistId, toChecklistId, position }) => {
        if (!state.isBoardVisible(boardId)) return;
        state.moveChecklistItem(cardId, itemId, fromChecklistId, toChecklistId, position);
      },
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_REBALANCED]: ({ boardId, cardId, checklistId, positions }) => {
        if (!state.isBoardVisible(boardId)) return;
        state.rebalanceChecklistItems(cardId, checklistId, positions);
      },
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_DELETED]: ({ boardId, cardId, checklistId, checklistParentItemId, itemId, completedAt }) => {
        if (!state.isBoardVisible(boardId)) return;
        state.removeChecklistItem(cardId, checklistId, itemId, completedAt, checklistParentItemId);
        state.removeAssignedChecklistItem(itemId);
      },

      // Board lifecycle: keep the visible-boards set in sync so card events route correctly.
      [SERVER_EVENTS.BOARD_UPDATED]: ({ board }) => {
        state.boards.update((bs) =>
          bs.map((b) => (b.id === board.id ? { id: board.id, workspaceId: board.workspaceId, name: board.name, icon: board.icon, iconColor: board.iconColor } : b)),
        );
      },
      [SERVER_EVENTS.BOARD_DELETED]: ({ boardId }) => {
        state.boards.update((bs) => bs.filter((b) => b.id !== boardId));
        state.removeCardsForBoard(boardId);
      },
    };

    const unregisterHandlers = registerSocketHandlers(socket, handlers);

    socket.on("connect", joinAllBoards);
    if (socket.connected) joinAllBoards();

    return () => {
      leaveWorkspace();
      for (const id of currentBoardIds()) socket.emit(CLIENT_EVENTS.BOARD_LEAVE, id);
      socket.off("connect", joinAllBoards);
      unregisterHandlers();
    };
  }
}
