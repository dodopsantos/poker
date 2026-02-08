import { prisma } from "../prisma";
import { redis } from "../redis";
import { buildDeck, shuffleInPlace, draw } from "./cards";
import type { HandStartOutcome, TableRuntimeState, RuntimePlayer } from "./types";

function runtimeKey(tableId: string) {
  return `table:${tableId}:runtime`;
}

export async function getRuntime(tableId: string): Promise<TableRuntimeState | null> {
  const raw = await redis.get(runtimeKey(tableId));
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function setRuntime(state: TableRuntimeState) {
  await redis.set(runtimeKey(state.tableId), JSON.stringify(state), "EX", 60 * 60);
}

export async function clearRuntime(tableId: string) {
  await redis.del(runtimeKey(tableId));
}

function now() {
  return Date.now();
}

function nextOccupiedSeat(occupied: number[], fromSeat: number): number {
  if (occupied.length === 0) throw new Error("NO_PLAYERS");
  const sorted = [...occupied].sort((a, b) => a - b);
  for (const s of sorted) if (s > fromSeat) return s;
  return sorted[0];
}

function firstOccupiedSeat(occupied: number[]): number {
  return [...occupied].sort((a, b) => a - b)[0];
}

export async function startHandIfReady(tableId: string): Promise<HandStartOutcome> {
  // If a hand is already running, noop
  const existing = await getRuntime(tableId);
  if (existing?.handId) return { started: false };

  // Load table + seated users
  const table = await prisma.table.findUnique({
    where: { id: tableId },
    include: { seats: { include: { user: true } } },
  });
  if (!table) throw new Error("TABLE_NOT_FOUND");

  const seated = table.seats
    .filter((s) => s.userId && (s.state === "SITTING" || s.state === "PLAYING") && (s.stack ?? 0) > 0)
    .sort((a, b) => a.seatNo - b.seatNo);

  if (seated.length < 2) return { started: false };

  const occupiedSeatNos = seated.map((s) => s.seatNo);

  // Determine dealer (first hand: lowest occupied seat)
  const dealerSeat = existing?.dealerSeat && occupiedSeatNos.includes(existing.dealerSeat)
    ? existing.dealerSeat
    : firstOccupiedSeat(occupiedSeatNos);

  // Blinds
  let sbSeat: number;
  let bbSeat: number;

  if (occupiedSeatNos.length === 2) {
    // Heads-up: dealer is SB, other is BB
    sbSeat = dealerSeat;
    bbSeat = nextOccupiedSeat(occupiedSeatNos, dealerSeat);
  } else {
    sbSeat = nextOccupiedSeat(occupiedSeatNos, dealerSeat);
    bbSeat = nextOccupiedSeat(occupiedSeatNos, sbSeat);
  }

  // First to act preflop
  const firstToAct = occupiedSeatNos.length === 2
    ? sbSeat // heads-up: SB (dealer) acts first preflop
    : nextOccupiedSeat(occupiedSeatNos, bbSeat);

  const handId = cryptoRandomId();

  // Build deck + shuffle
  const deck = shuffleInPlace(buildDeck());

  // Create runtime players
  const players: RuntimePlayer[] = seated.map((s) => ({
    seatNo: s.seatNo,
    userId: s.userId!,
    username: s.user?.username,
    stack: s.stack ?? 0,
    bet: 0,
    hasFolded: false,
    isAllIn: false,
    holeCards: [],
  }));

  // Deal hole cards
  for (let r = 0; r < 2; r++) {
    for (const p of players) {
      p.holeCards.push(...draw(deck, 1));
    }
  }

  const smallBlind = table.smallBlind;
  const bigBlind = table.bigBlind;

  // Post blinds (persist to DB atomically as best-effort)
  await prisma.$transaction(async (tx) => {
    // set table running
    await tx.table.update({ where: { id: tableId }, data: { status: "RUNNING" } });

    // mark playing
    await tx.tableSeat.updateMany({
      where: { tableId, userId: { not: null } },
      data: { state: "PLAYING" },
    });

    // apply SB
    const sb = players.find((p) => p.seatNo === sbSeat)!;
    const sbAmt = Math.min(sb.stack, smallBlind);
    sb.stack -= sbAmt;
    sb.bet += sbAmt;
    if (sb.stack === 0) sb.isAllIn = true;

    await tx.tableSeat.update({
      where: { tableId_seatNo: { tableId, seatNo: sbSeat } },
      data: { stack: sb.stack },
    });

    // apply BB
    const bb = players.find((p) => p.seatNo === bbSeat)!;
    const bbAmt = Math.min(bb.stack, bigBlind);
    bb.stack -= bbAmt;
    bb.bet += bbAmt;
    if (bb.stack === 0) bb.isAllIn = true;

    await tx.tableSeat.update({
      where: { tableId_seatNo: { tableId, seatNo: bbSeat } },
      data: { stack: bb.stack },
    });
  });

  const potTotal = players.reduce((sum, p) => sum + p.bet, 0);

  const runtime: TableRuntimeState = {
    tableId,
    handId,
    dealerSeat,
    currentTurnSeat: firstToAct,
    round: "PREFLOP",
    deck,
    board: [],
    pot: { total: potTotal },
    currentBet: bigBlind,
    minRaise: bigBlind,
    players,
    updatedAt: now(),
  };

  await setRuntime(runtime);

  // Invalidate public snapshot cache
  await redis.del(`table:${tableId}:state`);

  const privateCardsByUserId: Record<string, { handId: string; cards: string[]; seatNo: number }> = {};
  for (const p of players) privateCardsByUserId[p.userId] = { handId, cards: p.holeCards, seatNo: p.seatNo };

  return { started: true, publicState: null as any, privateCardsByUserId };
}

export async function getPrivateCards(tableId: string, userId: string) {
  const rt = await getRuntime(tableId);
  if (!rt?.handId) return null;
  const p = rt.players.find((x) => x.userId === userId);
  if (!p) return null;
  return { handId: rt.handId, cards: p.holeCards, seatNo: p.seatNo };
}

// crypto.randomUUID is available in newer Node, but keep a fallback.
function cryptoRandomId(): string {
  const g: any = globalThis as any;
  if (g?.crypto?.randomUUID) return g.crypto.randomUUID();
  // fallback
  return `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
}
