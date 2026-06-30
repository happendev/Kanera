import { ensureGuestBoardCapacity, ensureGuestBoardsCapacity } from "./paid-guest-seats.js";
import type { Db } from "../db.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function assertGuestBoardLimit(params: {
  hostClientId: string;
  boardId: string;
  userId: string;
  targetClientId?: string;
  createdById?: string;
  tx?: Tx;
}): Promise<{ paidGuestSeatCreated: boolean; paidGuestSeatActive: boolean }> {
  return ensureGuestBoardCapacity(params);
}

export async function assertGuestBoardLimitForBoards(params: {
  hostClientId: string;
  boardIds: string[];
  userId: string;
  targetClientId?: string;
  createdById?: string;
  tx?: Tx;
}): Promise<{ paidGuestSeatCreated: boolean; paidGuestSeatActive: boolean }> {
  return ensureGuestBoardsCapacity(params);
}
