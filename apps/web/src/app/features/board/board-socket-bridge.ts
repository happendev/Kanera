import { Injectable, inject } from "@angular/core";
import { CLIENT_EVENTS, expandWireCard, SERVER_EVENTS, type ServerToClientEvents, type WireWorkspaceMember } from "@kanera/shared/events";
import { registerSocketHandlers } from "../../core/realtime/socket-handlers";
import type { AppSocket } from "../../core/realtime/socket.service";
import { BoardState } from "./board-state";

export type AttachOptions = {
  onJoined?: () => void;
  onDesync?: () => void;
  onWorkDoneChanged?: () => void;
};

@Injectable()
export class BoardSocketBridge {
  private readonly state = inject(BoardState);

  attach(socket: AppSocket, boardId: string, options: AttachOptions = {}) {
    const state = this.state;
    const isCurrentWorkspace = (workspaceId: string) => state.board()?.workspaceId === workspaceId;
    const requestResync = () => options.onDesync?.();
    const workspaceMemberUser = (member: WireWorkspaceMember) => ({
      userId: member.userId,
      displayName: member.displayName ?? "Unknown",
      avatarUrl: member.avatarUrl ?? null,
      lastOnlineAt: member.lastOnlineAt ?? null,
      role: member.role,
      source: "workspace" as const,
    });
    const joinBoard = () => {
      socket.emit(CLIENT_EVENTS.BOARD_JOIN, boardId, (ok) => {
        if (!ok) console.warn("board:join rejected", boardId);
        else options.onJoined?.();
      });
    };
    const handlers: Partial<ServerToClientEvents> = {
      // Lists, labels, and custom fields are workspace-scoped, so ignore events from
      // other workspaces even if the socket connection itself remains alive.
      [SERVER_EVENTS.BOARD_UPDATED]: ({ board }) => { if (board.id === boardId) state.board.set(board); },
      [SERVER_EVENTS.LIST_CREATED]: ({ workspaceId, list }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.lists.update((ls) => [...ls.filter((l) => l.id !== list.id), list]);
      },
      [SERVER_EVENTS.LIST_UPDATED]: ({ workspaceId, list }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.lists.update((ls) => ls.map((l) => (l.id === list.id ? list : l)));
      },
      [SERVER_EVENTS.LIST_MOVED]: ({ workspaceId, listId, position }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.lists.update((ls) => ls.map((l) => (l.id === listId ? { ...l, position } : l)));
      },
      [SERVER_EVENTS.LIST_REBALANCED]: ({ workspaceId, positions }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        const positionsById = new Map(positions.map((p) => [p.id, p.position]));
        state.lists.update((ls) =>
          ls.map((l) => {
            const position = positionsById.get(l.id);
            return position ? { ...l, position } : l;
          }),
        );
      },
      [SERVER_EVENTS.LIST_DELETED]: ({ workspaceId, listId }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.lists.update((ls) => ls.filter((l) => l.id !== listId));
      },

      [SERVER_EVENTS.CARD_CREATED]: ({ boardId: eventBoardId, card }) => { if (eventBoardId === boardId) state.addCard(expandWireCard(card)); },
      [SERVER_EVENTS.CARD_UPDATED]: ({ boardId: eventBoardId, card }) => {
        if (eventBoardId !== boardId) return;
        state.updateCard(expandWireCard(card));
        state.noteCardDetailRealtimeMutation(card.id);
        options.onWorkDoneChanged?.();
      },
      [SERVER_EVENTS.CARD_MOVED]: ({ boardId: eventBoardId, cardId, toListId, position }) => {
        if (eventBoardId !== boardId) return;
        if (!state.hasCard(cardId) || !state.lists().some((list) => list.id === toListId)) {
          requestResync();
          return;
        }
        state.moveCard(cardId, toListId, position);
        // A concurrent detail fetch contains the card's list/position too. Mark the move so that
        // stale detail cannot put the card back after this realtime event has been applied.
        state.noteCardDetailRealtimeMutation(cardId);
      },
      [SERVER_EVENTS.CARD_REBALANCED]: ({ boardId: eventBoardId, positions }) => {
        if (eventBoardId !== boardId) return;
        if (positions.some((p) => !state.hasCard(p.id))) {
          requestResync();
          return;
        }
        state.rebalanceCards(positions);
        // Rebalancing changes every listed card's detail-level position. Track each card separately
        // because detail requests and their stale-response guards are scoped per card.
        for (const { id } of positions) state.noteCardDetailRealtimeMutation(id);
      },
      [SERVER_EVENTS.CARD_DELETED]: ({ boardId: eventBoardId, cardId }) => {
        if (eventBoardId !== boardId) return;
        if (!state.hasCard(cardId)) {
          requestResync();
          return;
        }
        state.removeCard(cardId);
      },
      [SERVER_EVENTS.SEPARATOR_CREATED]: ({ boardId: eventBoardId, separator }) => {
        if (eventBoardId === boardId) state.addSeparator(separator);
      },
      [SERVER_EVENTS.SEPARATOR_UPDATED]: ({ boardId: eventBoardId, separator }) => {
        if (eventBoardId === boardId) state.updateSeparator(separator);
      },
      [SERVER_EVENTS.SEPARATOR_MOVED]: ({ boardId: eventBoardId, separatorId, toListId, position }) => {
        if (eventBoardId !== boardId) return;
        if (!state.separatorsById().has(separatorId) || !state.lists().some((list) => list.id === toListId)) {
          requestResync();
          return;
        }
        state.moveSeparator(separatorId, toListId, position);
      },
      [SERVER_EVENTS.SEPARATOR_REBALANCED]: ({ boardId: eventBoardId, positions }) => {
        if (eventBoardId !== boardId) return;
        if (positions.some((p) => !state.separatorsById().has(p.id))) {
          requestResync();
          return;
        }
        state.rebalanceSeparators(positions);
      },
      [SERVER_EVENTS.SEPARATOR_DELETED]: ({ boardId: eventBoardId, separatorId }) => {
        if (eventBoardId !== boardId) return;
        if (!state.separatorsById().has(separatorId)) {
          requestResync();
          return;
        }
        state.removeSeparator(separatorId);
      },
      [SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_SET]: ({ boardId: eventBoardId, cardId, fieldId, valueText, valueNumber, valueCheckbox, valueDate, valueUrl, valueOptionIds, valueUserIds }) => {
        if (eventBoardId !== boardId) return;
        if (!state.hasCard(cardId) || !state.customFields().some((field) => field.id === fieldId)) {
          requestResync();
          return;
        }
        // Optimistic apply and realtime reconcile share the same state mutation path.
        state.upsertCustomFieldValue({
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
        });
        state.noteCardDetailRealtimeMutation(cardId);
      },
      [SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_CLEARED]: ({ boardId: eventBoardId, cardId, fieldId }) => {
        if (eventBoardId !== boardId) return;
        if (!state.hasCard(cardId)) {
          requestResync();
          return;
        }
        state.clearCustomFieldValue(cardId, fieldId);
        state.noteCardDetailRealtimeMutation(cardId);
      },
      [SERVER_EVENTS.CUSTOM_FIELD_CREATED]: ({ workspaceId, customField }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.customFields.update((fields) => state.sortCustomFields([...fields.filter((f) => f.id !== customField.id), customField]));
      },
      [SERVER_EVENTS.CUSTOM_FIELD_UPDATED]: ({ workspaceId, customField }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.customFields.update((fields) => state.sortCustomFields(fields.map((f) => (f.id === customField.id ? customField : f))));
      },
      [SERVER_EVENTS.CUSTOM_FIELD_MOVED]: ({ workspaceId, fieldId, position }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.customFields.update((fields) => state.sortCustomFields(fields.map((f) => (f.id === fieldId ? { ...f, position } : f))));
      },
      [SERVER_EVENTS.CUSTOM_FIELD_REBALANCED]: ({ workspaceId, positions }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        const positionsById = new Map(positions.map((p) => [p.id, p.position]));
        state.customFields.update((fields) =>
          state.sortCustomFields(
            fields.map((f) => {
              const position = positionsById.get(f.id);
              return position ? { ...f, position } : f;
            }),
          ),
        );
      },
      [SERVER_EVENTS.CUSTOM_FIELD_DELETED]: ({ workspaceId, fieldId }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.customFields.update((fields) => fields.filter((f) => f.id !== fieldId));
        state.customFieldValues.update((values) => values.filter((v) => v.fieldId !== fieldId));
      },
      [SERVER_EVENTS.CUSTOM_FIELD_OPTION_CREATED]: ({ workspaceId, fieldId, option }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.updateFieldOptions(fieldId, (options) => [...options.filter((o) => o.id !== option.id), option]);
      },
      [SERVER_EVENTS.CUSTOM_FIELD_OPTION_UPDATED]: ({ workspaceId, fieldId, option }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.updateFieldOptions(fieldId, (options) => options.map((o) => (o.id === option.id ? option : o)));
      },
      [SERVER_EVENTS.CUSTOM_FIELD_OPTION_MOVED]: ({ workspaceId, fieldId, optionId, position }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.updateFieldOptions(fieldId, (options) => options.map((o) => (o.id === optionId ? { ...o, position } : o)));
      },
      [SERVER_EVENTS.CUSTOM_FIELD_OPTION_REBALANCED]: ({ workspaceId, fieldId, positions }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        const positionsById = new Map(positions.map((p) => [p.id, p.position]));
        state.updateFieldOptions(fieldId, (options) =>
          options.map((o) => {
            const position = positionsById.get(o.id);
            return position ? { ...o, position } : o;
          }),
        );
      },
      [SERVER_EVENTS.CUSTOM_FIELD_OPTION_DELETED]: ({ workspaceId, fieldId, optionId }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.updateFieldOptions(fieldId, (options) => options.filter((o) => o.id !== optionId));
      },
      [SERVER_EVENTS.CARD_LABELS_SET]: ({ boardId: eventBoardId, cardId, labelIds }) => {
        if (eventBoardId !== boardId) return;
        if (!state.hasCard(cardId) || labelIds.some((labelId) => !state.cardLabels().some((label) => label.id === labelId))) {
          requestResync();
          return;
        }
        state.cardLabelAssignments.update((as) => [
          ...as.filter((a) => a.cardId !== cardId),
          ...labelIds.map((labelId) => ({ cardId, labelId, assignedAt: new Date() })),
        ]);
        state.noteCardDetailRealtimeMutation(cardId);
      },
      [SERVER_EVENTS.CARD_ASSIGNEES_SET]: ({ boardId: eventBoardId, cardId, assigneeIds }) => {
        if (eventBoardId !== boardId) return;
        if (!state.hasCard(cardId) || assigneeIds.some((userId) => !state.assignableMembers().some((member) => member.userId === userId))) {
          requestResync();
          return;
        }
        state.setCardAssignees(cardId, assigneeIds);
        state.noteCardDetailRealtimeMutation(cardId);
      },
      // Comment events only carry card identity, so the board state keeps a local count
      // map and folds those deltas back into summary cards when needed.
      [SERVER_EVENTS.COMMENT_CREATED]: ({ boardId: eventBoardId, cardId, comment }) => {
        if (eventBoardId !== boardId) return;
        if (!state.hasCard(cardId)) {
          requestResync();
          return;
        }
        if (!state.tryMarkCommentCreate(comment.id)) return;
        state.commentCounts.update((m) => {
          const next = new Map(m);
          next.set(cardId, (next.get(cardId) ?? 0) + 1);
          return next;
        });
      },
      [SERVER_EVENTS.COMMENT_DELETED]: ({ boardId: eventBoardId, cardId, commentId }) => {
        if (eventBoardId !== boardId) return;
        if (!state.hasCard(cardId)) {
          requestResync();
          return;
        }
        if (!state.tryMarkCommentDelete(commentId)) return;
        state.commentCounts.update((m) => {
          const prev = m.get(cardId) ?? 0;
          if (prev <= 1) {
            const next = new Map(m);
            next.delete(cardId);
            return next;
          }
          const next = new Map(m);
          next.set(cardId, prev - 1);
          return next;
        });
      },
      [SERVER_EVENTS.CARD_ATTACHMENT_CREATED]: ({ boardId: eventBoardId, attachment }) => {
        if (eventBoardId !== boardId) return;
        if (!state.hasCard(attachment.cardId)) {
          requestResync();
          return;
        }
        const isNew = !state.cardAttachments().some((a) => a.id === attachment.id);
        state.forgetAttachmentDelete(attachment.id);
        if (isNew) {
          state.incrementAttachmentCount(attachment.cardId);
        }
        state.cardAttachments.update((as) =>
          isNew ? [...as, attachment] : as.map((a) => (a.id === attachment.id ? attachment : a)),
        );
        state.noteCardDetailRealtimeMutation(attachment.cardId);
      },
      [SERVER_EVENTS.CARD_ATTACHMENT_DELETED]: ({ boardId: eventBoardId, cardId, attachmentId }) => {
        if (eventBoardId !== boardId) return;
        if (!state.hasCard(cardId)) {
          requestResync();
          return;
        }
        if (!state.tryMarkAttachmentDelete(attachmentId)) return;
        state.decrementAttachmentCount(cardId);
        state.cardAttachments.update((as) => as.filter((a) => a.id !== attachmentId));
        state.noteCardDetailRealtimeMutation(cardId);
      },
      [SERVER_EVENTS.CARD_CHECKLIST_CREATED]: ({ boardId: eventBoardId, cardId, checklist }) => {
        if (eventBoardId !== boardId) return;
        if (!state.hasCard(cardId)) {
          requestResync();
          return;
        }
        state.addChecklist(cardId, checklist);
        state.noteCardDetailRealtimeMutation(cardId);
      },
      [SERVER_EVENTS.CARD_CHECKLIST_UPDATED]: ({ boardId: eventBoardId, cardId, checklist }) => {
        if (eventBoardId !== boardId) return;
        state.updateChecklist(cardId, checklist);
        state.noteCardDetailRealtimeMutation(cardId);
      },
      [SERVER_EVENTS.CARD_CHECKLIST_MOVED]: ({ boardId: eventBoardId, cardId, checklistId, position }) => {
        if (eventBoardId !== boardId) return;
        state.moveChecklist(cardId, checklistId, position);
        state.noteCardDetailRealtimeMutation(cardId);
      },
      [SERVER_EVENTS.CARD_CHECKLIST_REBALANCED]: ({ boardId: eventBoardId, cardId, positions }) => {
        if (eventBoardId !== boardId) return;
        for (const position of positions) state.moveChecklist(cardId, position.id, position.position);
        state.noteCardDetailRealtimeMutation(cardId);
      },
      [SERVER_EVENTS.CARD_CHECKLIST_DELETED]: ({ boardId: eventBoardId, cardId, checklistId }) => {
        if (eventBoardId !== boardId) return;
        state.removeChecklist(cardId, checklistId);
        state.noteCardDetailRealtimeMutation(cardId);
      },
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_CREATED]: ({ boardId: eventBoardId, cardId, checklistId, item }) => {
        if (eventBoardId !== boardId) return;
        state.addChecklistItem(cardId, checklistId, item);
        state.noteCardDetailRealtimeMutation(cardId);
      },
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_UPDATED]: ({ boardId: eventBoardId, cardId, checklistId, item, prevCompletedAt }) => {
        if (eventBoardId !== boardId) return;
        state.updateChecklistItem(cardId, checklistId, item, prevCompletedAt);
        state.noteCardDetailRealtimeMutation(cardId);
        options.onWorkDoneChanged?.();
      },
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_MOVED]: ({ boardId: eventBoardId, cardId, itemId, fromChecklistId, toChecklistId, position }) => {
        if (eventBoardId !== boardId) return;
        state.moveChecklistItem(cardId, itemId, fromChecklistId, toChecklistId, position);
        state.noteCardDetailRealtimeMutation(cardId);
      },
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_REBALANCED]: ({ boardId: eventBoardId, cardId, checklistId, positions }) => {
        if (eventBoardId !== boardId) return;
        state.rebalanceChecklistItems(cardId, checklistId, positions);
        state.noteCardDetailRealtimeMutation(cardId);
      },
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_DELETED]: ({ boardId: eventBoardId, cardId, checklistId, itemId, completedAt }) => {
        if (eventBoardId !== boardId) return;
        state.removeChecklistItem(cardId, checklistId, itemId, completedAt);
        state.noteCardDetailRealtimeMutation(cardId);
      },
      [SERVER_EVENTS.BOARD_MEMBER_ADDED]: ({ boardId: eventBoardId, user }) => {
        if (eventBoardId !== boardId) return;
        state.members.update((ms) =>
          ms.some((m) => m.userId === user.userId) ? ms : [...ms, user],
        );
      },
      [SERVER_EVENTS.BOARD_MEMBER_REMOVED]: ({ boardId: eventBoardId, userId }) => {
        if (eventBoardId !== boardId) return;
        state.members.update((ms) => ms.filter((m) => m.userId !== userId));
      },
      [SERVER_EVENTS.WORKSPACE_MEMBER_ADDED]: ({ workspaceId, member }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        if (state.board()?.visibility === "private") return;
        const user = workspaceMemberUser(member);
        state.members.update((ms) => ms.some((m) => m.userId === user.userId) ? ms : [...ms, user]);
      },
      [SERVER_EVENTS.WORKSPACE_MEMBER_UPDATED]: ({ workspaceId, member }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        if (state.board()?.visibility === "private") return;
        state.members.update((ms) =>
          ms.map((m) => (m.userId === member.userId && m.source === "workspace" ? { ...m, role: member.role } : m)),
        );
      },
      [SERVER_EVENTS.WORKSPACE_MEMBER_REMOVED]: ({ workspaceId, userId }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.members.update((ms) => ms.filter((m) => !(m.userId === userId && m.source === "workspace")));
        state.cardAssignees.update((assignees) => assignees.filter((assignee) => assignee.userId !== userId));
      },
      [SERVER_EVENTS.CARD_LABEL_CREATED]: ({ workspaceId, cardLabel }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.cardLabels.update((ls) => [...ls.filter((l) => l.id !== cardLabel.id), cardLabel]);
      },
      [SERVER_EVENTS.CARD_LABEL_UPDATED]: ({ workspaceId, cardLabel }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.cardLabels.update((ls) => ls.map((l) => (l.id === cardLabel.id ? cardLabel : l)));
      },
      [SERVER_EVENTS.CARD_LABEL_MOVED]: ({ workspaceId, labelId, position }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.cardLabels.update((ls) => ls.map((l) => (l.id === labelId ? { ...l, position } : l)));
      },
      [SERVER_EVENTS.CARD_LABEL_REBALANCED]: ({ workspaceId, positions }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        const positionsById = new Map(positions.map((p) => [p.id, p.position]));
        state.cardLabels.update((ls) =>
          ls.map((l) => {
            const position = positionsById.get(l.id);
            return position ? { ...l, position } : l;
          }),
        );
      },
      [SERVER_EVENTS.CARD_LABEL_DELETED]: ({ workspaceId, labelId }) => {
        if (!isCurrentWorkspace(workspaceId)) return;
        state.cardLabels.update((ls) => ls.filter((l) => l.id !== labelId));
      },
    };

    const unregisterHandlers = registerSocketHandlers(socket, handlers);

    socket.on("connect", joinBoard);
    if (socket.connected) joinBoard();

    return () => {
      socket.emit(CLIENT_EVENTS.BOARD_LEAVE, boardId);
      socket.off("connect", joinBoard);
      unregisterHandlers();
    };
  }
}
