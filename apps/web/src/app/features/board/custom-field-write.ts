import type { CardCustomFieldValue } from "@kanera/shared/schema";
import type { BoardState } from "./board-state";

/** A response may settle this field only while its captured store snapshot is still current. */
export type SettleCustomFieldWrite = (value: CardCustomFieldValue | null) => void;

export function captureBoardCustomFieldWrite(state: BoardState, cardId: string, fieldId: string, boardId: string): SettleCustomFieldWrite {
  const board = state.board();
  const revision = state.customFieldValueRevision(cardId, fieldId);
  const previous = state.customFieldValuesForCard(cardId).get(fieldId);
  return (value) => {
    // A websocket echo (including a newer remote edit), fresh hydration or board navigation wins
    // over a delayed acknowledgement. Read the actual store, never the component's delayed inputs.
    if (board?.id !== boardId || state.board() !== board || state.customFieldValuesForCard(cardId).get(fieldId) !== previous) return;
    // Per-field tombstones also detect SET/CLEAR cycles without letting unrelated edits suppress
    // this acknowledgement before its own echo arrives and strand the next picker gesture.
    if (state.customFieldValueRevision(cardId, fieldId) !== revision) return;
    if (value) state.upsertCustomFieldValue(value);
    else state.clearCustomFieldValue(cardId, fieldId);
  };
}
