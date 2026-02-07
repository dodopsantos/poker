import { prisma } from "../prisma";
import { redis } from "../redis";
import { ensureWallet } from "./wallet.service";

function tableStateKey(tableId: string) {
    return `table:${tableId}:state`;
}

export async function getOrBuildTableState(tableId: string) {
    const cached = await redis.get(tableStateKey(tableId));
    if (cached) return JSON.parse(cached);

    const table = await prisma.table.findUnique({
        where: { id: tableId },
        include: { seats: { include: { user: true } } },
    });
    if (!table) throw new Error("TABLE_NOT_FOUND");

    const state = {
        table: {
            id: table.id,
            name: table.name,
            smallBlind: table.smallBlind,
            bigBlind: table.bigBlind,
            maxPlayers: table.maxPlayers,
            status: table.status,
        },
        seats: table.seats
            .sort((a, b) => a.seatNo - b.seatNo)
            .map((s) => ({
                seatNo: s.seatNo,
                state: s.state,
                user: s.user ? { id: s.user.id, username: s.user.username } : undefined,
                stack: s.stack,
                bet: 0,
            })),
        game: {
            handId: null,
            round: null,
            board: [],
            pot: { total: 0 },
            currentBet: 0,
            minRaise: table.bigBlind,
        },
        updatedAt: Date.now(),
    };

    await redis.set(tableStateKey(tableId), JSON.stringify(state), "EX", 60 * 60);
    return state;
}

export async function sitAtTable(params: {
    tableId: string;
    userId: string;
    seatNo: number;
    buyInAmount: number;
}) {
    const { tableId, userId, seatNo, buyInAmount } = params;

    // garante seat existe
    const seat = await prisma.tableSeat.findUnique({
        where: { tableId_seatNo: { tableId, seatNo } },
    });
    if (!seat) throw new Error("SEAT_NOT_FOUND");
    if (seat.userId) throw new Error("SEAT_TAKEN");

    // aplica buy-in na wallet (débito)
    // (feito fora daqui, no gateway, ou chame wallet.buyIn aqui se preferir)

    // ocupa o seat
    await prisma.tableSeat.update({
        where: { tableId_seatNo: { tableId, seatNo } },
        data: {
            userId,
            stack: buyInAmount,
            state: "SITTING",
        },
    });

    // invalida cache e rebuild
    await redis.del(tableStateKey(tableId));
    return getOrBuildTableState(tableId);
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

export async function leaveTable(params: { tableId: string; userId: string }) {
    const { tableId, userId } = params;

    const seat = await prisma.tableSeat.findFirst({
        where: { tableId, userId },
    });
    if (!seat) return null;

    // cashout automático do stack para a wallet
    // (feito fora daqui, no gateway, ou aqui chamando wallet.cashOut)

    await prisma.tableSeat.update({
        where: { id: seat.id },
        data: { userId: null, stack: 0, state: "EMPTY" },
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
