import { prisma } from "../prisma";
import { redis } from "../redis";
import { ensureWallet } from "./wallet.service";
import { getRuntime } from "../poker/runtime";

function tableStateKey(tableId: string) {
  return `table:${tableId}:state`;
}

type PublicTableState = any;

async function buildPublicState(tableId: string): Promise<PublicTableState> {
  const table = await prisma.table.findUnique({
    where: { id: tableId },
    include: { seats: { include: { user: true } } },
  });
  if (!table) throw new Error("TABLE_NOT_FOUND");

  const rt = await getRuntime(tableId);

  const seats = table.seats
    .sort((a, b) => a.seatNo - b.seatNo)
    .map((s) => {
      const p = rt?.players?.[s.seatNo];
      const bet = p ? p.bet : 0;
      const stack = p ? p.stack : (s.stack ?? 0);

      return {
        seatNo: s.seatNo,
        state: s.state,
        user: s.user ? { id: s.user.id, username: s.user.username } : undefined,
        stack,
        bet,
        hasFolded: p ? p.hasFolded : false,
        isAllIn: p ? p.isAllIn : false,
        isDealer: rt ? rt.dealerSeat === s.seatNo : false,
        isTurn: rt ? rt.currentTurnSeat === s.seatNo : false,
      };
    });

  const game = rt
    ? {
        handId: rt.handId,
        round: rt.round,
        board: rt.board,
        pot: rt.pot,
        currentBet: rt.currentBet,
        minRaise: rt.minRaise,
        // Fields needed for client reconnection / timer sync
        turnEndsAt: (rt as any).turnEndsAt ?? null,
        isDealingBoard: (rt as any).isDealingBoard ?? false,
        autoRunout: (rt as any).autoRunout ?? false,
      }
    : {
        handId: null,
        round: null,
        board: [],
        pot: { total: 0 },
        currentBet: 0,
        minRaise: table.bigBlind,
        turnEndsAt: null,
        isDealingBoard: false,
        autoRunout: false,
      };

  return {
    table: {
      id: table.id,
      name: table.name,
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
      maxPlayers: table.maxPlayers,
      status: table.status,
    },
    seats,
    game,
    updatedAt: Date.now(),
  };
}

export async function getOrBuildTableState(tableId: string) {
  // If there's an active runtime, don't serve stale snapshots for long.
  const rt = await getRuntime(tableId);
  if (rt) {
    const state = await buildPublicState(tableId);
    await redis.set(tableStateKey(tableId), JSON.stringify(state), "EX", 3);
    return state;
  }

  const cached = await redis.get(tableStateKey(tableId));
  if (cached) return JSON.parse(cached);

  const state = await buildPublicState(tableId);
  await redis.set(tableStateKey(tableId), JSON.stringify(state), "EX", 60 * 60);
  return state;
}

// Versão atômica (recomendada): debita wallet + ocupa o seat na mesma transação.
export async function sitWithBuyIn(params: {
  tableId: string;
  userId: string;
  seatNo: number;
  buyInAmount: number;
}) {
  const { tableId, userId, seatNo, buyInAmount } = params;
  if (buyInAmount <= 0) throw new Error("INVALID_AMOUNT");

  await ensureWallet(userId);

  await prisma.$transaction(async (tx) => {
    const seat = await tx.tableSeat.findUnique({
      where: { tableId_seatNo: { tableId, seatNo } },
    });
    if (!seat) throw new Error("SEAT_NOT_FOUND");
    if (seat.userId) throw new Error("SEAT_TAKEN");

    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new Error("WALLET_NOT_FOUND");
    if (wallet.balance < buyInAmount) throw new Error("INSUFFICIENT_FUNDS");

    await tx.wallet.update({ where: { userId }, data: { balance: { decrement: buyInAmount } } });
    await tx.ledgerTransaction.create({
      data: { userId, tableId, type: "BUYIN", amount: -buyInAmount },
    });
    await tx.tableSeat.update({
      where: { tableId_seatNo: { tableId, seatNo } },
      data: { userId, stack: buyInAmount, state: "SITTING" },
    });
  });

  await redis.del(tableStateKey(tableId));
  return getOrBuildTableState(tableId);
}

// Versão atômica (recomendada): zera seat + credita wallet (cashout) na mesma transação.
export async function leaveWithCashout(params: { tableId: string; userId: string }) {
  const { tableId, userId } = params;
  await ensureWallet(userId);

  await prisma.$transaction(async (tx) => {
    const seat = await tx.tableSeat.findFirst({ where: { tableId, userId } });
    if (!seat) return;

    const stack = seat.stack ?? 0;

    await tx.tableSeat.update({
      where: { id: seat.id },
      data: { userId: null, stack: 0, state: "EMPTY" },
    });

    if (stack > 0) {
      await tx.wallet.update({ where: { userId }, data: { balance: { increment: stack } } });
      await tx.ledgerTransaction.create({
        data: { userId, tableId, type: "CASHOUT", amount: stack },
      });
    }
  });

  await redis.del(tableStateKey(tableId));
  return getOrBuildTableState(tableId);
}
