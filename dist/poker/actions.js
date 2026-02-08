"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyTableAction = applyTableAction;
const prisma_1 = require("../prisma");
const runtime_1 = require("./runtime");
const cards_1 = require("./cards");
const showdown_1 = require("./showdown");
function activeSeats(rt) {
    return Object.values(rt.players)
        .filter((p) => !p.hasFolded)
        .map((p) => p.seatNo)
        .sort((a, b) => a - b);
}
function nextActiveSeat(rt, fromSeat) {
    const act = activeSeats(rt);
    for (const s of act)
        if (s > fromSeat)
            return s;
    return act[0];
}
function onlyOneLeft(rt) {
    const act = activeSeats(rt);
    return act.length === 1 ? act[0] : null;
}
function isRoundSettled(rt) {
    const act = Object.values(rt.players).filter((p) => !p.hasFolded);
    if (act.length <= 1)
        return true;
    // Each player must get a chance to act on streets where currentBet == 0.
    // With the old logic, "CHECK" by the first player would instantly settle the round
    // (because everyone had bet=0), skipping the other player's turn.
    const allActed = act.every((p) => p.stack === 0 || rt.actedThisRound[p.seatNo] === true);
    if (rt.currentBet === 0) {
        return allActed;
    }
    const allMatched = act.every((p) => p.stack === 0 || p.bet === rt.currentBet);
    return allMatched && allActed;
}
function resetBets(rt) {
    for (const p of Object.values(rt.players))
        p.bet = 0;
    rt.currentBet = 0;
    rt.lastAggressorSeat = null;
    // Reset per-street action tracking.
    for (const k of Object.keys(rt.actedThisRound))
        rt.actedThisRound[Number(k)] = false;
}
function dealBoard(rt, n) {
    const d = (0, cards_1.draw)(rt.deck, n);
    rt.deck = d.rest;
    rt.board.push(...d.drawn);
}
async function persistStacks(tableId, rt) {
    await prisma_1.prisma.$transaction(async (tx) => {
        for (const p of Object.values(rt.players)) {
            await tx.tableSeat.update({
                where: { tableId_seatNo: { tableId, seatNo: p.seatNo } },
                data: { stack: p.stack },
            });
        }
    });
}
async function applyTableAction(params) {
    const { tableId, userId, action, amount } = params;
    const rt = await (0, runtime_1.getRuntime)(tableId);
    if (!rt)
        throw new Error("NO_HAND_RUNNING");
    // While the server is revealing board cards (timed animation), no one may act.
    if (rt.isDealingBoard)
        throw new Error("DEALING_BOARD");
    const seat = Object.values(rt.players).find((p) => p.userId === userId);
    if (!seat)
        throw new Error("NOT_SEATED");
    if (seat.hasFolded)
        throw new Error("ALREADY_FOLDED");
    if (rt.currentTurnSeat !== seat.seatNo)
        throw new Error("NOT_YOUR_TURN");
    const toCall = Math.max(0, rt.currentBet - seat.bet);
    if (action === "FOLD") {
        seat.hasFolded = true;
        rt.actedThisRound[seat.seatNo] = true;
    }
    else if (action === "CHECK") {
        if (toCall !== 0)
            throw new Error("CANNOT_CHECK");
        rt.actedThisRound[seat.seatNo] = true;
    }
    else if (action === "CALL") {
        const pay = Math.min(toCall, seat.stack);
        seat.stack -= pay;
        seat.bet += pay;
        seat.committed += pay;
        rt.pot.total += pay;
        if (seat.stack === 0)
            seat.isAllIn = true;
        rt.actedThisRound[seat.seatNo] = true;
    }
    else if (action === "RAISE") {
        let raiseTo = Number(amount ?? 0);
        if (!Number.isFinite(raiseTo) || raiseTo <= rt.currentBet)
            throw new Error("INVALID_RAISE");
        const minTo = rt.currentBet === 0 ? rt.minRaise : rt.currentBet + rt.minRaise;
        const requestedNeed = raiseTo - seat.bet;
        if (requestedNeed <= 0)
            throw new Error("INVALID_RAISE");
        // Allow all-in raises even if the user requested amount is too high.
        // This supports side pots; the betting rules for "re-opening" action are simplified for MVP.
        let need = requestedNeed;
        if (need > seat.stack) {
            // Go all-in to the maximum possible.
            raiseTo = seat.bet + seat.stack;
            need = seat.stack;
            if (raiseTo <= rt.currentBet)
                throw new Error("INSUFFICIENT_STACK");
        }
        const isAllInRaise = need === seat.stack;
        // Enforce minimum raise size unless it's an all-in raise (common poker rule).
        if (raiseTo < minTo && !isAllInRaise)
            throw new Error("RAISE_TOO_SMALL");
        seat.stack -= need;
        seat.bet = raiseTo;
        seat.committed += need;
        rt.pot.total += need;
        if (seat.stack === 0)
            seat.isAllIn = true;
        // Update raise sizing info only when this is a "full" raise.
        if (raiseTo >= minTo) {
            rt.minRaise = raiseTo - rt.currentBet;
        }
        rt.currentBet = raiseTo;
        rt.lastAggressorSeat = seat.seatNo;
        // After a raise, everyone must get a new chance to respond.
        for (const k of Object.keys(rt.actedThisRound))
            rt.actedThisRound[Number(k)] = false;
        rt.actedThisRound[seat.seatNo] = true;
    }
    // win by everyone folding
    const winnerByFold = onlyOneLeft(rt);
    if (winnerByFold != null) {
        rt.players[winnerByFold].stack += rt.pot.total;
        await persistStacks(tableId, rt);
        await (0, runtime_1.clearRuntime)(tableId);
        return { runtime: null, handEnded: true, winnerSeat: winnerByFold };
    }
    // advance turn / rounds
    if (isRoundSettled(rt)) {
        // if round ends, move to next
        const next = (0, runtime_1.roundNext)(rt.round);
        rt.round = next;
        // reset bets each street
        resetBets(rt);
        if (next === "FLOP" || next === "TURN" || next === "RIVER") {
            // Draw the street cards now, but reveal them later via timed snapshots.
            const n = next === "FLOP" ? 3 : 1;
            const d = (0, cards_1.draw)(rt.deck, n);
            rt.deck = d.rest;
            rt.pendingBoard = d.drawn;
            rt.isDealingBoard = true;
        }
        else if (next === "SHOWDOWN") {
            // Ensure pot total matches the sum of all committed chips (important for side pots).
            rt.pot.total = Object.values(rt.players).reduce((sum, p) => sum + Math.max(0, Math.floor(p.committed ?? 0)), 0);
            // Resolve showdown using poker-evaluator (lib).
            const { reveal, winners } = await (0, showdown_1.resolveShowdown)({ tableId, rt });
            // Pay pot to winners
            for (const w of winners) {
                const p = rt.players[w.seatNo];
                if (p)
                    p.stack += w.payout;
            }
            await persistStacks(tableId, rt);
            await (0, runtime_1.clearRuntime)(tableId);
            return { runtime: null, handEnded: true, showdown: { reveal, winners, pot: rt.pot.total } };
        }
        // set turn to first active seat after dealer for postflop
        rt.currentTurnSeat = nextActiveSeat(rt, rt.dealerSeat);
    }
    else {
        // next player's turn
        rt.currentTurnSeat = nextActiveSeat(rt, rt.currentTurnSeat);
    }
    await (0, runtime_1.setRuntime)(tableId, rt);
    await persistStacks(tableId, rt);
    return { runtime: rt, handEnded: false };
}
