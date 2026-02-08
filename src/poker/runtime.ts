import { redis } from "../redis";
import { prisma } from "../prisma";
import { buildDeck, shuffle, draw } from "./cards";
import type { TableRuntime, BettingRound, SeatRuntime } from "./types";

function runtimeKey(tableId: string) {
  return `table:${tableId}:runtime`;
}
function privateKey(tableId: string, handId: string, userId: string) {
  return `table:${tableId}:hand:${handId}:private:${userId}`;
}
function lockKey(tableId: string) {
  return `table:${tableId}:hand_lock`;
}

function dealerKey(tableId: string) {
  return `table:${tableId}:dealerSeat`;
}

export async function getRuntime(tableId: string): Promise<TableRuntime | null> {
  const raw = await redis.get(runtimeKey(tableId));
  if (!raw) return null;
  return JSON.parse(raw) as TableRuntime;
}

export async function setRuntime(tableId: string, rt: TableRuntime): Promise<void> {
  await redis.set(runtimeKey(tableId), JSON.stringify(rt), "EX", 60 * 60);
}

export async function clearRuntime(tableId: string): Promise<void> {
  await redis.del(runtimeKey(tableId));
}

function nextOccupied(seatNos: number[], fromSeat: number): number {
  const sorted = seatNos.slice().sort((a,b)=>a-b);
  for (const s of sorted) if (s > fromSeat) return s;
  return sorted[0];
}

export async function startHandIfReady(tableId: string): Promise<{ started: boolean; runtime: TableRuntime | null }> {
  // fast path
  const existing = await getRuntime(tableId);
  if (existing) return { started: false, runtime: existing };

  // lock to avoid double start
  const locked = await redis.set(lockKey(tableId), "1", "PX", 5000, "NX");
  if (!locked) {
    const rt = await getRuntime(tableId);
    return { started: false, runtime: rt };
  }

  try {
    const table = await prisma.table.findUnique({
      where: { id: tableId },
      include: { seats: true },
    });
    if (!table) throw new Error("TABLE_NOT_FOUND");

    const seated = table.seats
      .filter((s) => s.userId && (s.state === "SITTING" || s.state === "PLAYING") && (s.stack ?? 0) > 0)
      .map((s) => ({ seatNo: s.seatNo, userId: s.userId!, stack: s.stack ?? 0 }));

    if (seated.length < 2) return { started: false, runtime: null };

    const seatNos = seated.map((s: any) => s.seatNo);
    // Dealer rotation: keep a pointer in Redis and advance to the next occupied seat each hand.
    const prevDealerRaw = await redis.get(dealerKey(tableId));
    const prevDealer = prevDealerRaw ? Number(prevDealerRaw) : null;
    const fallbackDealer = seatNos.slice().sort((a, b) => a - b)[0];
    const dealerSeat = Number.isFinite(prevDealer as any)
      ? nextOccupied(seatNos, prevDealer as number)
      : fallbackDealer;

    // Blind rules (Cash Game / Hold'em):
    // - Heads-up: dealer is SB, other is BB.
    // - 3+ players: SB is next after dealer, BB is next after SB.
    const isHeadsUp = seatNos.length === 2;
    const sbSeat = isHeadsUp ? dealerSeat : nextOccupied(seatNos, dealerSeat);
    const bbSeat = isHeadsUp ? nextOccupied(seatNos, dealerSeat) : nextOccupied(seatNos, sbSeat);

    const handId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    // build players runtime
    const players: Record<number, SeatRuntime> = {};
    for (const s of seated) {
      players[s.seatNo] = {
        seatNo: s.seatNo,
        userId: s.userId,
        stack: s.stack,
        bet: 0,
        committed: 0,
        isAllIn: false,
        hasFolded: false,
      };
    }

    // shuffle + deal
    let deck = shuffle(buildDeck());
    for (const s of seated) {
      const d1 = draw(deck, 2);
      deck = d1.rest;
      await redis.set(privateKey(tableId, handId, s.userId), JSON.stringify({ cards: d1.drawn }), "EX", 60 * 60);
    }

    // post blinds
    const sb = Math.min(table.smallBlind, players[sbSeat].stack);
    const bb = Math.min(table.bigBlind, players[bbSeat].stack);

    players[sbSeat].stack -= sb;
    players[sbSeat].bet += sb;
    players[sbSeat].committed += sb;
    if (players[sbSeat].stack === 0) players[sbSeat].isAllIn = true;
    players[sbSeat].committed += sb;
    if (players[sbSeat].stack === 0) players[sbSeat].isAllIn = true;

    players[bbSeat].stack -= bb;
    players[bbSeat].bet += bb;
    players[bbSeat].committed += bb;
    if (players[bbSeat].stack === 0) players[bbSeat].isAllIn = true;
    players[bbSeat].committed += bb;
    if (players[bbSeat].stack === 0) players[bbSeat].isAllIn = true;

    // Preflop first action is seat after BB (except HU where dealer/SB acts first).
    const currentTurnSeat = isHeadsUp ? sbSeat : nextOccupied(seatNos, bbSeat);

    // Initialize per-street action tracking.
    const actedThisRound: Record<number, boolean> = {};
    for (const s of seatNos) actedThisRound[s] = false;

    const runtime: TableRuntime = {
      handId,
      round: "PREFLOP",
      dealerSeat,
      currentTurnSeat,
      deck,
      board: [],
      pot: { total: sb + bb },
      currentBet: bb,
      minRaise: table.bigBlind,
      lastAggressorSeat: bbSeat,
      actedThisRound,
      players,
    };

    // Persist the dealer pointer for the next hand.
    await redis.set(dealerKey(tableId), String(dealerSeat), "EX", 60 * 60 * 24);

    // persist seat stacks + mark PLAYING + table RUNNING
    await prisma.$transaction(async (tx: any) => {
      await tx.table.update({ where: { id: tableId }, data: { status: "RUNNING" } });
      for (const seatNo of seatNos) {
        const p = players[seatNo];
        await tx.tableSeat.update({
          where: { tableId_seatNo: { tableId, seatNo } },
          data: { stack: p.stack, state: "PLAYING" },
        });
      }
    });

    await setRuntime(tableId, runtime);
    return { started: true, runtime };
  } finally {
    await redis.del(lockKey(tableId));
  }
}

export async function getPrivateCards(tableId: string, handId: string, userId: string): Promise<string[] | null> {
  const raw = await redis.get(privateKey(tableId, handId, userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { cards: string[] };
    return parsed.cards ?? null;
  } catch {
    return null;
  }
}

export function roundNext(round: BettingRound): BettingRound {
  if (round === "PREFLOP") return "FLOP";
  if (round === "FLOP") return "TURN";
  if (round === "TURN") return "RIVER";
  return "SHOWDOWN";
}