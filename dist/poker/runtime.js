"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRuntime = getRuntime;
exports.setRuntime = setRuntime;
exports.clearRuntime = clearRuntime;
exports.startHandIfReady = startHandIfReady;
exports.getPrivateCards = getPrivateCards;
exports.roundNext = roundNext;
const redis_1 = require("../redis");
const prisma_1 = require("../prisma");
const cards_1 = require("./cards");
function runtimeKey(tableId) {
    return `table:${tableId}:runtime`;
}
function privateKey(tableId, handId, userId) {
    return `table:${tableId}:hand:${handId}:private:${userId}`;
}
function lockKey(tableId) {
    return `table:${tableId}:hand_lock`;
}
function dealerKey(tableId) {
    return `table:${tableId}:dealerSeat`;
}
async function getRuntime(tableId) {
    const raw = await redis_1.redis.get(runtimeKey(tableId));
    if (!raw)
        return null;
    return JSON.parse(raw);
}
async function setRuntime(tableId, rt) {
    await redis_1.redis.set(runtimeKey(tableId), JSON.stringify(rt), "EX", 60 * 60);
}
async function clearRuntime(tableId) {
    await redis_1.redis.del(runtimeKey(tableId));
}
function nextOccupied(seatNos, fromSeat) {
    const sorted = seatNos.slice().sort((a, b) => a - b);
    for (const s of sorted)
        if (s > fromSeat)
            return s;
    return sorted[0];
}
async function startHandIfReady(tableId) {
    // fast path
    const existing = await getRuntime(tableId);
    if (existing)
        return { started: false, runtime: existing };
    // lock to avoid double start
    const locked = await redis_1.redis.set(lockKey(tableId), "1", "PX", 5000, "NX");
    if (!locked) {
        const rt = await getRuntime(tableId);
        return { started: false, runtime: rt };
    }
    try {
        const table = await prisma_1.prisma.table.findUnique({
            where: { id: tableId },
            include: { seats: true },
        });
        if (!table)
            throw new Error("TABLE_NOT_FOUND");
        const seated = table.seats
            .filter((s) => s.userId && (s.state === "SITTING" || s.state === "PLAYING") && (s.stack ?? 0) > 0)
            .map((s) => ({ seatNo: s.seatNo, userId: s.userId, stack: s.stack ?? 0 }));
        if (seated.length < 2)
            return { started: false, runtime: null };
        const seatNos = seated.map((s) => s.seatNo);
        // Dealer rotation: keep a pointer in Redis and advance to the next occupied seat each hand.
        const prevDealerRaw = await redis_1.redis.get(dealerKey(tableId));
        const prevDealer = prevDealerRaw ? Number(prevDealerRaw) : null;
        const fallbackDealer = seatNos.slice().sort((a, b) => a - b)[0];
        const dealerSeat = Number.isFinite(prevDealer)
            ? nextOccupied(seatNos, prevDealer)
            : fallbackDealer;
        // Blind rules (Cash Game / Hold'em):
        // - Heads-up: dealer is SB, other is BB.
        // - 3+ players: SB is next after dealer, BB is next after SB.
        const isHeadsUp = seatNos.length === 2;
        const sbSeat = isHeadsUp ? dealerSeat : nextOccupied(seatNos, dealerSeat);
        const bbSeat = isHeadsUp ? nextOccupied(seatNos, dealerSeat) : nextOccupied(seatNos, sbSeat);
        const handId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        // build players runtime
        const players = {};
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
        let deck = (0, cards_1.shuffle)((0, cards_1.buildDeck)());
        for (const s of seated) {
            const d1 = (0, cards_1.draw)(deck, 2);
            deck = d1.rest;
            await redis_1.redis.set(privateKey(tableId, handId, s.userId), JSON.stringify({ cards: d1.drawn }), "EX", 60 * 60);
        }
        // post blinds
        const sb = Math.min(table.smallBlind, players[sbSeat].stack);
        const bb = Math.min(table.bigBlind, players[bbSeat].stack);
        players[sbSeat].stack -= sb;
        players[sbSeat].bet += sb;
        players[sbSeat].committed += sb;
        if (players[sbSeat].stack === 0)
            players[sbSeat].isAllIn = true;
        players[sbSeat].committed += sb;
        if (players[sbSeat].stack === 0)
            players[sbSeat].isAllIn = true;
        players[bbSeat].stack -= bb;
        players[bbSeat].bet += bb;
        players[bbSeat].committed += bb;
        if (players[bbSeat].stack === 0)
            players[bbSeat].isAllIn = true;
        players[bbSeat].committed += bb;
        if (players[bbSeat].stack === 0)
            players[bbSeat].isAllIn = true;
        // Preflop first action is seat after BB (except HU where dealer/SB acts first).
        const currentTurnSeat = isHeadsUp ? sbSeat : nextOccupied(seatNos, bbSeat);
        // Initialize per-street action tracking.
        const actedThisRound = {};
        for (const s of seatNos)
            actedThisRound[s] = false;
        const runtime = {
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
        await redis_1.redis.set(dealerKey(tableId), String(dealerSeat), "EX", 60 * 60 * 24);
        // persist seat stacks + mark PLAYING + table RUNNING
        await prisma_1.prisma.$transaction(async (tx) => {
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
    }
    finally {
        await redis_1.redis.del(lockKey(tableId));
    }
}
async function getPrivateCards(tableId, handId, userId) {
    const raw = await redis_1.redis.get(privateKey(tableId, handId, userId));
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed.cards ?? null;
    }
    catch {
        return null;
    }
}
function roundNext(round) {
    if (round === "PREFLOP")
        return "FLOP";
    if (round === "FLOP")
        return "TURN";
    if (round === "TURN")
        return "RIVER";
    return "SHOWDOWN";
}
