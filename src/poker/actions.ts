import { prisma } from "../prisma";
import { getRuntime, setRuntime, clearRuntime, roundNext } from "./runtime";
import type { TableRuntime, BettingRound } from "./types";
import { draw } from "./cards";
import { resolveShowdown } from "./showdown";

const TURN_TIME_MS = Number(process.env.TURN_TIME_MS ?? 15000);

export type PlayerAction = "CHECK" | "CALL" | "RAISE" | "FOLD";

type SeatLike = { seatNo: number; hasFolded?: boolean; isAllIn?: boolean; stack?: number; bet?: number };

function contenders(rt: TableRuntime): SeatLike[] {
  return Object.values(rt.players).filter((p) => !p.hasFolded);
}

// Seats that can still take actions (not folded, not all-in, stack > 0)
function actionables(rt: TableRuntime): SeatLike[] {
  return contenders(rt).filter((p) => !p.isAllIn && (p.stack ?? 0) > 0);
}

function activeSeatNos(rt: TableRuntime): number[] {
  return contenders(rt)
    .map((p) => p.seatNo)
    .sort((a, b) => a - b);
}

function actionableSeatNos(rt: TableRuntime): number[] {
  return actionables(rt)
    .map((p) => p.seatNo)
    .sort((a, b) => a - b);
}

function nextSeatFrom(list: number[], fromSeat: number): number {
  if (!list.length) return fromSeat;
  for (const s of list) if (s > fromSeat) return s;
  return list[0];
}

function nextActionableSeat(rt: TableRuntime, fromSeat: number): number {
  return nextSeatFrom(actionableSeatNos(rt), fromSeat);
}

function nextActiveSeat(rt: TableRuntime, fromSeat: number): number {
  return nextSeatFrom(activeSeatNos(rt), fromSeat);
}

function onlyOneLeft(rt: TableRuntime): number | null {
  const act = activeSeatNos(rt);
  return act.length === 1 ? act[0] : null;
}

function isRoundSettled(rt: TableRuntime): boolean {
  const act = contenders(rt);
  if (act.length <= 1) return true;

  const actionable = actionables(rt);

  // If nobody can act (everyone remaining is all-in / has 0 stack),
  // there are no further decisions possible this betting round.
  if (actionable.length === 0) return true;

  // Each player must get a chance to act on streets where currentBet == 0.
  // With the old logic, "CHECK" by the first player would instantly settle the round
  // (because everyone had bet=0), skipping the other player's turn.
  const allActed = act.every((p) => p.isAllIn || p.stack === 0 || rt.actedThisRound[p.seatNo] === true);

  if (rt.currentBet === 0) {
    return allActed;
  }

  const allMatched = act.every((p) => p.isAllIn || p.stack === 0 || p.bet === rt.currentBet);
  return allMatched && allActed;
}

function shouldAutoRunout(rt: TableRuntime): boolean {
  // Auto-runout is ONLY valid once the current betting round is actually settled.
  // Otherwise, a player going all-in would instantly skip the opponent's decision (call/fold).
  if (!isRoundSettled(rt)) return false;

  const cont = contenders(rt);
  if (cont.length < 2) return false;

  const hasAllIn = cont.some((p) => p.isAllIn || p.stack === 0);
  if (!hasAllIn) return false;

  // If at most one player can still act after the round is settled, there is no meaningful betting left.
  return actionables(rt).length <= 1;
}

function setTurnDeadline(rt: TableRuntime) {
  // No actions allowed while revealing board cards, or during auto-runout.
  if ((rt as any).isDealingBoard || (rt as any).autoRunout) {
    (rt as any).turnEndsAt = null;
    return;
  }

  const actionable = actionables(rt);
  if (actionable.length === 0) {
    (rt as any).turnEndsAt = null;
    return;
  }

  const isCurrentTurnActionable = actionable.some((p) => p.seatNo === rt.currentTurnSeat);
  if (!isCurrentTurnActionable) {
    rt.currentTurnSeat = nextActionableSeat(rt, rt.currentTurnSeat);
  }

  (rt as any).turnEndsAt = Date.now() + TURN_TIME_MS;
}

function resetBets(rt: TableRuntime) {
  for (const p of Object.values(rt.players)) p.bet = 0;
  rt.currentBet = 0;
  rt.lastAggressorSeat = null;

  // Reset per-street action tracking.
  for (const k of Object.keys(rt.actedThisRound)) rt.actedThisRound[Number(k)] = false;
}

function dealBoard(rt: TableRuntime, n: number) {
  const d = draw(rt.deck, n);
  rt.deck = d.rest;
  rt.board.push(...d.drawn);
}

async function persistStacks(tableId: string, rt: TableRuntime) {
  await prisma.$transaction(async (tx: any) => {
    for (const p of Object.values(rt.players)) {
      await tx.tableSeat.update({
        where: { tableId_seatNo: { tableId, seatNo: p.seatNo } },
        data: { stack: p.stack },
      });
    }
  });
}

export async function applyTableAction(params: {
  tableId: string;
  userId: string;
  action: PlayerAction;
  amount?: number;
  /** True when this action was forced by the server because the player's turn timer expired. */
  timeout?: boolean;
}): Promise<
  | { runtime: TableRuntime; handEnded: false }
  | { runtime: null; handEnded: true; winnerSeat: number }
  | {
      runtime: null;
      handEnded: true;
      showdown: {
        pot: number;
        reveal: Array<{ seatNo: number; userId: string; cards: string[] }>;
        winners: Array<{ seatNo: number; userId: string; payout: number }>;
      };
    }
> {
  const { tableId, userId, action, amount, timeout } = params;

  const rt = await getRuntime(tableId);
  if (!rt) throw new Error("NO_HAND_RUNNING");

  // While the server is revealing board cards (timed animation), no one may act.
  if ((rt as any).isDealingBoard) throw new Error("DEALING_BOARD");

  const seat = Object.values(rt.players).find((p) => p.userId === userId);
  if (!seat) throw new Error("NOT_SEATED");
  if (seat.hasFolded) throw new Error("ALREADY_FOLDED");
  if (rt.currentTurnSeat !== seat.seatNo) throw new Error("NOT_YOUR_TURN");

  const toCall = Math.max(0, rt.currentBet - seat.bet);

  // Track consecutive turn timeouts per player.
  // - If this was a timeout-forced action: increment.
  // - Otherwise (player acted normally): reset.
  if (timeout) {
    seat.timeoutsInRow = (seat.timeoutsInRow ?? 0) + 1;
  } else {
    seat.timeoutsInRow = 0;
  }

  // Track consecutive timeouts (used to auto-remove "away" players).
  if (timeout) {
    seat.timeoutsInRow = (seat.timeoutsInRow ?? 0) + 1;
  } else {
    seat.timeoutsInRow = 0;
  }

  // Track consecutive timeouts (used by the gateway to remove "away" players).
  // Any non-timeout action resets the counter.
  if (params.timeout) {
    seat.timeoutsInRow = (seat.timeoutsInRow ?? 0) + 1;
  } else {
    seat.timeoutsInRow = 0;
  }

  if (action === "FOLD") {
    seat.hasFolded = true;
    rt.actedThisRound[seat.seatNo] = true;
  } else if (action === "CHECK") {
    if (toCall !== 0) throw new Error("CANNOT_CHECK");
    rt.actedThisRound[seat.seatNo] = true;
  } else if (action === "CALL") {
    const pay = Math.min(toCall, seat.stack);
    seat.stack -= pay;
    seat.bet += pay;
    seat.committed += pay;
    rt.pot.total += pay;
    if (seat.stack === 0) seat.isAllIn = true;
    rt.actedThisRound[seat.seatNo] = true;
  } else if (action === "RAISE") {
    let raiseTo = Number(amount ?? 0);
    if (!Number.isFinite(raiseTo) || raiseTo <= rt.currentBet) throw new Error("INVALID_RAISE");

    const minTo = rt.currentBet === 0 ? rt.minRaise : rt.currentBet + rt.minRaise;
    const requestedNeed = raiseTo - seat.bet;
    if (requestedNeed <= 0) throw new Error("INVALID_RAISE");

    // Allow all-in raises even if the user requested amount is too high.
    // This supports side pots; the betting rules for "re-opening" action are simplified for MVP.
    let need = requestedNeed;
    if (need > seat.stack) {
      // Go all-in to the maximum possible.
      raiseTo = seat.bet + seat.stack;
      need = seat.stack;
      if (raiseTo <= rt.currentBet) throw new Error("INSUFFICIENT_STACK");
    }

    const isAllInRaise = need === seat.stack;
    // Enforce minimum raise size unless it's an all-in raise (common poker rule).
    if (raiseTo < minTo && !isAllInRaise) throw new Error("RAISE_TOO_SMALL");

    seat.stack -= need;
    seat.bet = raiseTo;
    seat.committed += need;
    rt.pot.total += need;
    if (seat.stack === 0) seat.isAllIn = true;

    // Update raise sizing info only when this is a "full" raise.
    if (raiseTo >= minTo) {
      rt.minRaise = raiseTo - rt.currentBet;
    }
    rt.currentBet = raiseTo;
    rt.lastAggressorSeat = seat.seatNo;

    // After a raise, everyone must get a new chance to respond.
    for (const k of Object.keys(rt.actedThisRound)) rt.actedThisRound[Number(k)] = false;
    rt.actedThisRound[seat.seatNo] = true;
  }

  // win by everyone folding
  const winnerByFold = onlyOneLeft(rt);
  if (winnerByFold != null) {
    rt.players[winnerByFold].stack += rt.pot.total;
    await persistStacks(tableId, rt);
    await clearRuntime(tableId);
    return { runtime: null, handEnded: true, winnerSeat: winnerByFold };
  }

  // advance turn / rounds
  if (isRoundSettled(rt)) {
    // if round ends, move to next
    const next = roundNext(rt.round);
    rt.round = next;

    // reset bets each street
    resetBets(rt);

    if (next === "FLOP" || next === "TURN" || next === "RIVER") {
      // Draw the street cards now, but reveal them later via timed snapshots.
      // This keeps the server authoritative AND lets clients animate card dealing.
      const n = next === "FLOP" ? 3 : 1;
      const d = draw(rt.deck, n);
      rt.deck = d.rest;
      (rt as any).pendingBoard = d.drawn;
      (rt as any).isDealingBoard = true;
    }
    else if (next === "SHOWDOWN") {
      // Ensure pot total matches the sum of all committed chips (important for side pots).
      rt.pot.total = Object.values(rt.players).reduce((sum, p) => sum + Math.max(0, Math.floor(p.committed ?? 0)), 0);

      // Resolve showdown using poker-evaluator (lib).
      const { reveal, winners } = await resolveShowdown({ tableId, rt });

      // Pay pot to winners
      for (const w of winners) {
        const p = rt.players[w.seatNo];
        if (p) p.stack += w.payout;
      }

      await persistStacks(tableId, rt);
      await clearRuntime(tableId);

      return { runtime: null, handEnded: true, showdown: { reveal, winners, pot: rt.pot.total } };
    }

    // If betting is over because everyone else is all-in, we auto-runout the rest of the board.
    // The gateway will keep revealing streets until SHOWDOWN.
    (rt as any).autoRunout = shouldAutoRunout(rt);

    // set turn to first actionable seat after dealer for postflop
    rt.currentTurnSeat = nextActionableSeat(rt, rt.dealerSeat);
    setTurnDeadline(rt);
  } else {
    // next player's turn
    rt.currentTurnSeat = nextActionableSeat(rt, rt.currentTurnSeat);
    setTurnDeadline(rt);
  }

  await setRuntime(tableId, rt);
  await persistStacks(tableId, rt);

  return { runtime: rt, handEnded: false };
}

/**
 * When a hand reaches a state where there are no meaningful actions left (everyone else is all-in),
 * we keep dealing streets automatically until SHOWDOWN. This is triggered by the gateway right
 * after a street reveal finishes.
 */
export async function advanceAutoRunout(tableId: string): Promise<
  | null
  | { runtime: TableRuntime; handEnded: false }
  | {
      runtime: null;
      handEnded: true;
      showdown: {
        pot: number;
        reveal: Array<{ seatNo: number; userId: string; cards: string[] }>;
        winners: Array<{ seatNo: number; userId: string; payout: number }>;
      };
    }
> {
  const rt = await getRuntime(tableId);
  if (!rt) return null;

  // Only continue if auto-runout mode is enabled.
  if (!(rt as any).autoRunout) return null;

  // Don't interfere while a street is being revealed.
  if ((rt as any).isDealingBoard) return null;

  // If players became able to act again (e.g., side pot scenario with 3+ players), stop.
  if (!shouldAutoRunout(rt)) {
    (rt as any).autoRunout = false;
    await setRuntime(tableId, rt);
    return { runtime: rt, handEnded: false };
  }

  // If we already have a full board, go to showdown.
  if (rt.board.length >= 5 || rt.round === "SHOWDOWN") {
    rt.round = "SHOWDOWN";
    rt.pot.total = Object.values(rt.players).reduce((sum, p) => sum + Math.max(0, Math.floor(p.committed ?? 0)), 0);

    const { reveal, winners } = await resolveShowdown({ tableId, rt });
    for (const w of winners) {
      const p = rt.players[w.seatNo];
      if (p) p.stack += w.payout;
    }

    await persistStacks(tableId, rt);
    await clearRuntime(tableId);

    return { runtime: null, handEnded: true, showdown: { reveal, winners, pot: rt.pot.total } };
  }

  // Otherwise, advance one street and queue the pending board reveal.
  const next = roundNext(rt.round);
  rt.round = next;
  resetBets(rt);

  if (next === "FLOP" || next === "TURN" || next === "RIVER") {
    const n = next === "FLOP" ? 3 : 1;
    const d = draw(rt.deck, n);
    rt.deck = d.rest;
    (rt as any).pendingBoard = d.drawn;
    (rt as any).isDealingBoard = true;
    rt.currentTurnSeat = nextActionableSeat(rt, rt.dealerSeat);
    setTurnDeadline(rt);
    await setRuntime(tableId, rt);
    return { runtime: rt, handEnded: false };
  }

  // Fallback: if something unexpected happens, disable auto-runout.
  (rt as any).autoRunout = false;
  await setRuntime(tableId, rt);
  return { runtime: rt, handEnded: false };
}
