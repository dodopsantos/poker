/**
 * Hand history service.
 * Saves hand data to the database for audit, replay, and dispute resolution.
 */

import { prisma } from "../prisma";
import type { TableRuntime } from "../poker/types";

type HandHistoryParams = {
  tableId: string;
  runtime: TableRuntime;
  result:
    | { type: "fold"; winnerSeat: number; winnerUserId: string; payout: number }
    | {
        type: "showdown";
        reveal: Array<{ seatNo: number; userId: string; cards: string[]; handRank?: number }>;
        winners: Array<{ seatNo: number; userId: string; payout: number; handRank?: number }>;
      };
  smallBlind: number;
  bigBlind: number;
  actions?: Array<{ round: string; seatNo: number; action: string; amount?: number }>;
};

/**
 * Saves a completed hand to the database.
 * Call this once when a hand ends (either by fold or showdown).
 */
export async function saveHandHistory(params: HandHistoryParams): Promise<void> {
  const { tableId, runtime, result, smallBlind, bigBlind, actions } = params;

  try {
    // Build players summary
    const players = Object.values(runtime.players).map((p) => ({
      seatNo: p.seatNo,
      userId: p.userId,
      startStack: (p.stack ?? 0) + (p.committed ?? 0), // Reconstruct starting stack
      endStack: p.stack ?? 0,
      committed: p.committed ?? 0,
      hasFolded: p.hasFolded,
      isAllIn: p.isAllIn,
    }));

    // Build result summary
    const resultData =
      result.type === "fold"
        ? { type: "fold", winnerSeat: result.winnerSeat, winnerUserId: result.winnerUserId, payout: result.payout }
        : {
            type: "showdown",
            reveal: result.reveal.map((r) => ({
              seatNo: r.seatNo,
              userId: r.userId,
              cards: r.cards,
              handRank: r.handRank,
            })),
            winners: result.winners.map((w) => ({
              seatNo: w.seatNo,
              userId: w.userId,
              payout: w.payout,
              handRank: w.handRank,
            })),
          };

    await prisma.handHistory.create({
      data: {
        tableId,
        handId: runtime.handId,
        dealerSeat: runtime.dealerSeat,
        smallBlind,
        bigBlind,
        players: players as any, // Prisma Json type
        board: runtime.board as any,
        result: resultData as any,
        actions: actions as any,
      },
    });
  } catch (err) {
    // Don't crash the game if history save fails — just log it.
    console.error("[hand-history] Failed to save hand:", err);
  }
}

/**
 * Retrieves hand history for a table (paginated).
 */
export async function getTableHandHistory(params: { tableId: string; limit?: number; offset?: number }) {
  const { tableId, limit = 50, offset = 0 } = params;

  return prisma.handHistory.findMany({
    where: { tableId },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
  });
}

/**
 * Retrieves a specific hand by handId.
 */
export async function getHandById(handId: string) {
  return prisma.handHistory.findFirst({
    where: { handId },
  });
}
