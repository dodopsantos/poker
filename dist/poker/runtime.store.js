"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRuntime = getRuntime;
exports.setRuntime = setRuntime;
exports.clearRuntime = clearRuntime;
exports.startHandIfReady = startHandIfReady;
exports.getPrivateCards = getPrivateCards;
const prisma_1 = require("../prisma");
const redis_1 = require("../redis");
const cards_1 = require("./cards");
function runtimeKey(tableId) {
    return `table:${tableId}:runtime`;
}
async function getRuntime(tableId) {
    const raw = await redis_1.redis.get(runtimeKey(tableId));
    if (!raw)
        return null;
    return JSON.parse(raw);
}
async function setRuntime(state) {
    await redis_1.redis.set(runtimeKey(state.tableId), JSON.stringify(state), "EX", 60 * 60);
}
async function clearRuntime(tableId) {
    await redis_1.redis.del(runtimeKey(tableId));
}
function now() {
    return Date.now();
}
function nextOccupiedSeat(occupied, fromSeat) {
    if (occupied.length === 0)
        throw new Error("NO_PLAYERS");
    const sorted = [...occupied].sort((a, b) => a - b);
    for (const s of sorted)
        if (s > fromSeat)
            return s;
    return sorted[0];
}
function firstOccupiedSeat(occupied) {
    return [...occupied].sort((a, b) => a - b)[0];
}
async function startHandIfReady(tableId) {
    // If a hand is already running, noop
    const existing = await getRuntime(tableId);
    if (existing?.handId)
        return { started: false };
    // Load table + seated users
    const table = await prisma_1.prisma.table.findUnique({
        where: { id: tableId },
        include: { seats: { include: { user: true } } },
    });
    if (!table)
        throw new Error("TABLE_NOT_FOUND");
    const seated = table.seats
        .filter((s) => s.userId && (s.state === "SITTING" || s.state === "PLAYING") && (s.stack ?? 0) > 0)
        .sort((a, b) => a.seatNo - b.seatNo);
    if (seated.length < 2)
        return { started: false };
    const occupiedSeatNos = seated.map((s) => s.seatNo);
    // Determine dealer (first hand: lowest occupied seat)
    const dealerSeat = existing?.dealerSeat && occupiedSeatNos.includes(existing.dealerSeat)
        ? existing.dealerSeat
        : firstOccupiedSeat(occupiedSeatNos);
    // Blinds
    let sbSeat;
    let bbSeat;
    if (occupiedSeatNos.length === 2) {
        // Heads-up: dealer is SB, other is BB
        sbSeat = dealerSeat;
        bbSeat = nextOccupiedSeat(occupiedSeatNos, dealerSeat);
    }
    else {
        sbSeat = nextOccupiedSeat(occupiedSeatNos, dealerSeat);
        bbSeat = nextOccupiedSeat(occupiedSeatNos, sbSeat);
    }
    // First to act preflop
    const firstToAct = occupiedSeatNos.length === 2
        ? sbSeat // heads-up: SB (dealer) acts first preflop
        : nextOccupiedSeat(occupiedSeatNos, bbSeat);
    const handId = cryptoRandomId();
    // Build deck + shuffle
    const deck = (0, cards_1.shuffleInPlace)((0, cards_1.buildDeck)());
    // Create runtime players
    const players = seated.map((s) => ({
        seatNo: s.seatNo,
        userId: s.userId,
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
            p.holeCards.push(...(0, cards_1.draw)(deck, 1));
        }
    }
    const smallBlind = table.smallBlind;
    const bigBlind = table.bigBlind;
    // Post blinds (persist to DB atomically as best-effort)
    await prisma_1.prisma.$transaction(async (tx) => {
        // set table running
        await tx.table.update({ where: { id: tableId }, data: { status: "RUNNING" } });
        // mark playing
        await tx.tableSeat.updateMany({
            where: { tableId, userId: { not: null } },
            data: { state: "PLAYING" },
        });
        // apply SB
        const sb = players.find((p) => p.seatNo === sbSeat);
        const sbAmt = Math.min(sb.stack, smallBlind);
        sb.stack -= sbAmt;
        sb.bet += sbAmt;
        if (sb.stack === 0)
            sb.isAllIn = true;
        await tx.tableSeat.update({
            where: { tableId_seatNo: { tableId, seatNo: sbSeat } },
            data: { stack: sb.stack },
        });
        // apply BB
        const bb = players.find((p) => p.seatNo === bbSeat);
        const bbAmt = Math.min(bb.stack, bigBlind);
        bb.stack -= bbAmt;
        bb.bet += bbAmt;
        if (bb.stack === 0)
            bb.isAllIn = true;
        await tx.tableSeat.update({
            where: { tableId_seatNo: { tableId, seatNo: bbSeat } },
            data: { stack: bb.stack },
        });
    });
    const potTotal = players.reduce((sum, p) => sum + p.bet, 0);
    const runtime = {
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
    await redis_1.redis.del(`table:${tableId}:state`);
    const privateCardsByUserId = {};
    for (const p of players)
        privateCardsByUserId[p.userId] = { handId, cards: p.holeCards, seatNo: p.seatNo };
    return { started: true, publicState: null, privateCardsByUserId };
}
async function getPrivateCards(tableId, userId) {
    const rt = await getRuntime(tableId);
    if (!rt?.handId)
        return null;
    const p = rt.players.find((x) => x.userId === userId);
    if (!p)
        return null;
    return { handId: rt.handId, cards: p.holeCards, seatNo: p.seatNo };
}
// crypto.randomUUID is available in newer Node, but keep a fallback.
function cryptoRandomId() {
    const g = globalThis;
    if (g?.crypto?.randomUUID)
        return g.crypto.randomUUID();
    // fallback
    return `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
}
