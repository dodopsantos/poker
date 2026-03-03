"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTableGateway = registerTableGateway;
const table_service_1 = require("../services/table.service");
const wallet_service_1 = require("../services/wallet.service");
const runtime_1 = require("../poker/runtime");
const actions_1 = require("../poker/actions");
// --- Server-timed UX (PokerStars-like pacing) ---
// Board dealing (flop/turn/river) reveal timings
const STREET_PRE_DELAY_MS = 250;
const BOARD_CARD_INTERVAL_MS = 220;
const STREET_POST_DELAY_MS = 350;
// Hand end pacing
const SHOWDOWN_HOLD_MS = 2500;
const WIN_BY_FOLD_HOLD_MS = 1500;
const TURN_TIME_MS = Number(process.env.TURN_TIME_MS ?? 15000);
const AWAY_TIMEOUTS_IN_ROW = Number(process.env.AWAY_TIMEOUTS_IN_ROW ?? 2);
// In-memory per-table reveal lock to avoid overlapping reveal sequences.
const revealingTables = new Set();

// In-memory per-table turn timer (server authoritative).
const turnTimers = new Map();

// Track consecutive timeouts per user per table (in-memory, resets on any manual action).
const timeoutStrikes = new Map();

// Players that exceeded the timeout limit are only removed (cashout) when a betting round ends
// (i.e., when the game advances to the next street) or when the hand ends.
const pendingAwayKick = new Map(); // tableId -> Set<userId>

function markPendingKick(tableId, userId) {
    const set = pendingAwayKick.get(tableId) ?? new Set();
    set.add(userId);
    pendingAwayKick.set(tableId, set);
}
function clearPendingKick(tableId, userId) {
    pendingAwayKick.get(tableId)?.delete(userId);
}
async function flushPendingKicks(io, tableId) {
    const set = pendingAwayKick.get(tableId);
    if (!set || set.size === 0)
        return;
    let newState = null;
    for (const uid of Array.from(set)) {
        try {
            newState = await (0, table_service_1.leaveWithCashout)({ tableId, userId: uid });
            resetTimeoutStrike(tableId, uid);
            clearPendingKick(tableId, uid);
        }
        catch {
            clearPendingKick(tableId, uid);
        }
    }
    if (newState) {
        io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state: newState });
        io.to("lobby").emit("lobby:table_updated", { tableId });
    }
}
function incTimeoutStrike(tableId, userId) {
    const m = timeoutStrikes.get(tableId) ?? new Map();
    const next = (m.get(userId) ?? 0) + 1;
    m.set(userId, next);
    timeoutStrikes.set(tableId, m);
    return next;
}
function resetTimeoutStrike(tableId, userId) {
    const m = timeoutStrikes.get(tableId);
    if (!m)
        return;
    m.set(userId, 0);
}
function clearTurnTimer(tableId) {
    const t = turnTimers.get(tableId);
    if (t)
        clearTimeout(t);
    turnTimers.delete(tableId);
}
async function scheduleTurnTimer(io, tableId) {
    clearTurnTimer(tableId);
    const rt = await (0, runtime_1.getRuntime)(tableId);
    if (!rt)
        return;
    if (rt.isDealingBoard)
        return;
    if (rt.autoRunout)
        return;
    const endsAt = Number(rt.turnEndsAt ?? NaN);
    if (!Number.isFinite(endsAt) || endsAt <= 0)
        return;
    const delay = Math.max(0, endsAt - Date.now());
    const timer = setTimeout(() => {
        void (async () => {
            try {
                const rt2 = await (0, runtime_1.getRuntime)(tableId);
                if (!rt2)
                    return;
                if (rt2.isDealingBoard)
                    return;
                if (rt2.autoRunout)
                    return;
                const endsAt2 = Number(rt2.turnEndsAt ?? NaN);
                if (!Number.isFinite(endsAt2) || endsAt2 !== endsAt)
                    return;
                const seatNo = rt2.currentTurnSeat;
                const seat = rt2.players?.[seatNo];
                if (!seat || seat.hasFolded)
                    return;
                const beforeRound = rt2.round;
                const toCall = Math.max(0, (rt2.currentBet ?? 0) - (seat.bet ?? 0));
                const forced = toCall === 0 ? "CHECK" : "FOLD";
                // Count this as a timeout strike for this user.
                const strikes = incTimeoutStrike(tableId, seat.userId);
                if (strikes >= AWAY_TIMEOUTS_IN_ROW) {
                    markPendingKick(tableId, seat.userId);
                }
                const result = await (0, actions_1.applyTableAction)({ tableId, userId: seat.userId, action: forced, timeout: true });
                const state = await (0, table_service_1.getOrBuildTableState)(tableId);
                io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });

                // Only remove "away" players when a betting round ends (street advances) or when the hand ends.
                const roundAdvanced = !result?.handEnded && result?.runtime && result.runtime.round !== beforeRound;
                if (roundAdvanced) {
                    await flushPendingKicks(io, tableId);
                }

                // If the timeout ended the hand by everyone folding, broadcast and start next hand with pacing.
                if (result?.handEnded && result?.winnerSeat != null) {
                    await flushPendingKicks(io, tableId);
                    const winnerSeat = result.winnerSeat;
                    const winnerUserId = result.winnerUserId;
                    const payout = result.payout;
                    io.to(`table:${tableId}`).emit("table:event", { type: "HAND_ENDED", tableId, winners: [{ seatNo: winnerSeat, userId: winnerUserId, payout }], pot: payout });
                    clearTurnTimer(tableId);
                    setTimeout(() => {
                        void (async () => {
                            try {
                                const start = await (0, runtime_1.startHandIfReady)(tableId);
                                if (start.started && start.runtime) {
                                    const newState = await (0, table_service_1.getOrBuildTableState)(tableId);
                                    io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state: newState });
                                    io.to(`table:${tableId}`).emit("table:event", { type: "HAND_STARTED", tableId, handId: start.runtime.handId, round: start.runtime.round });
                                    for (const p of Object.values(start.runtime.players)) {
                                        const cards = await (0, runtime_1.getPrivateCards)(tableId, start.runtime.handId, p.userId);
                                        if (cards)
                                            io.to(`user:${p.userId}`).emit("table:private_cards", { tableId, handId: start.runtime.handId, cards });
                                    }
                                    void scheduleTurnTimer(io, tableId);
                                }
                            }
                            catch {
                                // ignore
                            }
                        })();
                    }, WIN_BY_FOLD_HOLD_MS);
                    return;
                }
                void (async () => {
                    try {
                        const rta = await (0, runtime_1.getRuntime)(tableId);
                        const pending = Array.isArray(rta?.pendingBoard) ? rta.pendingBoard : [];
                        if (rta && rta.isDealingBoard && pending.length) {
                            await revealPendingBoard(io, tableId, () => (0, table_service_1.getOrBuildTableState)(tableId), () => (0, runtime_1.getRuntime)(tableId), (r) => (0, runtime_1.setRuntime)(tableId, r));
                        }
                        const auto = await runAutoRunout(io, tableId, () => (0, table_service_1.getOrBuildTableState)(tableId), () => (0, runtime_1.getRuntime)(tableId), (r) => (0, runtime_1.setRuntime)(tableId, r));
                        if (auto?.showdown) {
                            const sd = auto.showdown;
                            await flushPendingKicks(io, tableId);
                            io.to(`table:${tableId}`).emit("table:event", { type: "SHOWDOWN_REVEAL", tableId, pot: sd.pot, reveal: sd.reveal, winners: sd.winners });
                            io.to(`table:${tableId}`).emit("table:event", { type: "HAND_ENDED", tableId, winners: sd.winners, pot: sd.pot });
                            setTimeout(() => {
                                void (async () => {
                                    try {
                                        const start = await (0, runtime_1.startHandIfReady)(tableId);
                                        if (start.started && start.runtime) {
                                            const newState = await (0, table_service_1.getOrBuildTableState)(tableId);
                                            io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state: newState });
                                            io.to(`table:${tableId}`).emit("table:event", { type: "HAND_STARTED", tableId, handId: start.runtime.handId, round: start.runtime.round });
                                            for (const p of Object.values(start.runtime.players)) {
                                                const cards = await (0, runtime_1.getPrivateCards)(tableId, start.runtime.handId, p.userId);
                                                if (cards)
                                                    io.to(`user:${p.userId}`).emit("table:private_cards", { tableId, handId: start.runtime.handId, cards });
                                            }
                                        }
                                    }
                                    catch {
                                        // ignore
                                    }
                                })();
                            }, SHOWDOWN_HOLD_MS);
                            return;
                        }
                    }
                    catch {
                        // ignore
                    }
                })();
                if (result.handEnded) {
                    clearTurnTimer(tableId);
                    return;
                }
                await scheduleTurnTimer(io, tableId);
            }
            catch {
                // ignore
            }
        })();
    }, delay + 20);
    turnTimers.set(tableId, timer);
}
async function revealPendingBoard(io, tableId, getState, getRt, setRt) {
    if (revealingTables.has(tableId))
        return;
    const rt0 = await getRt();
    const pending = Array.isArray(rt0?.pendingBoard) ? rt0.pendingBoard : [];
    if (!pending.length)
        return;
    revealingTables.add(tableId);
    try {
        // Small pause before the first card appears.
        await new Promise((r) => setTimeout(r, STREET_PRE_DELAY_MS));
        for (let i = 0; i < pending.length; i++) {
            const rt = await getRt();
            const cards = Array.isArray(rt?.pendingBoard) ? rt.pendingBoard : [];
            if (!cards.length)
                break;
            const card = cards.shift();
            rt.board = Array.isArray(rt.board) ? rt.board : [];
            rt.board.push(card);
            rt.pendingBoard = cards;
            await setRt(rt);
            const state = await getState();
            io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });
            // Interval between cards (flop: 3x)
            await new Promise((r) => setTimeout(r, BOARD_CARD_INTERVAL_MS));
        }
        // Finish dealing, unlock actions.
        const rtFinal = await getRt();
        if (rtFinal) {
            rtFinal.pendingBoard = [];
            rtFinal.isDealingBoard = false;

            // Actions are available again: reset turn deadline (unless auto-runout).
            if (!rtFinal.autoRunout) {
                rtFinal.turnEndsAt = Date.now() + TURN_TIME_MS;
            }
            await setRt(rtFinal);
            const state = await getState();
            io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });

            // Actions are unlocked again; (re)schedule the turn timer.
            void scheduleTurnTimer(io, tableId);
        }
        await new Promise((r) => setTimeout(r, STREET_POST_DELAY_MS));
    }
    finally {
        revealingTables.delete(tableId);
    }
}
async function runAutoRunout(io, tableId, getState, getRt, setRt) {
    // Keep advancing streets while auto-runout is enabled.
    for (let guard = 0; guard < 10; guard++) {
        const step = await (0, actions_1.advanceAutoRunout)(tableId);
        if (!step)
            return null;
        const state = await getState();
        io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });

        // If auto-runout stops and action becomes possible again, this schedules the next turn.
        void scheduleTurnTimer(io, tableId);
        if (step.handEnded && step.showdown) {
            return { showdown: step.showdown };
        }
        const rt = await getRt();
        const pending = Array.isArray(rt?.pendingBoard) ? rt.pendingBoard : [];
        if (rt && rt.isDealingBoard && pending.length) {
            await revealPendingBoard(io, tableId, getState, getRt, setRt);
            // Loop again after the reveal.
            continue;
        }
        // Nothing left to do.
        return null;
    }
    return null;
}
function registerTableGateway(io, socket) {
    const user = socket.data.user;
    socket.on("table:join", async ({ tableId }) => {
        await (0, wallet_service_1.ensureWallet)(user.userId);
        socket.join(`table:${tableId}`);
        const state = await (0, table_service_1.getOrBuildTableState)(tableId);
        socket.emit("table:state", state);

        // Ensure server turn timer is scheduled for this table.
        void scheduleTurnTimer(io, tableId);
        // If there's a running hand and the user is seated, send private cards
        if (state.game?.handId) {
            const cards = await (0, runtime_1.getPrivateCards)(tableId, state.game.handId, user.userId);
            if (cards)
                socket.emit("table:private_cards", { tableId, handId: state.game.handId, cards });
        }
    });
    socket.on("table:sit", async ({ tableId, seatNo, buyInAmount }) => {
        try {
            const stateAfterSit = await (0, table_service_1.sitWithBuyIn)({ tableId, userId: user.userId, seatNo, buyInAmount });
            // Maybe start a hand
            const start = await (0, runtime_1.startHandIfReady)(tableId);
            const state = await (0, table_service_1.getOrBuildTableState)(tableId);
            io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });

            // After any action, the turn/deadline may have changed.
            void scheduleTurnTimer(io, tableId);

            // Seat/hand state changed; schedule (or reschedule) the turn timer.
            void scheduleTurnTimer(io, tableId);

            // Seat/hand state changed; schedule (or reschedule) the turn timer.
            void scheduleTurnTimer(io, tableId);
            if (start.started && start.runtime) {
                io.to(`table:${tableId}`).emit("table:event", {
                    type: "HAND_STARTED",
                    tableId,
                    handId: start.runtime.handId,
                    round: start.runtime.round,
                });
                // Send private cards to each seated user
                for (const p of Object.values(start.runtime.players)) {
                    const cards = await (0, runtime_1.getPrivateCards)(tableId, start.runtime.handId, p.userId);
                    if (cards)
                        io.to(`user:${p.userId}`).emit("table:private_cards", { tableId, handId: start.runtime.handId, cards });
                }

                // Hand started sets a new turn/deadline; schedule the timer.
                void scheduleTurnTimer(io, tableId);
            }
            io.to("lobby").emit("lobby:table_updated", { tableId });
        }
        catch (e) {
            socket.emit("table:event", { type: "ERROR", code: e.message ?? "UNKNOWN", message: "Could not sit." });
        }
    });
    socket.on("table:leave", async ({ tableId }) => {
        try {
            const newState = await (0, table_service_1.leaveWithCashout)({ tableId, userId: user.userId });
            io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state: newState });
            io.to("lobby").emit("lobby:table_updated", { tableId });
        }
        catch (e) {
            socket.emit("table:event", { type: "ERROR", code: e.message ?? "UNKNOWN", message: "Could not leave." });
        }
    });
    socket.on("table:action", async ({ tableId, action, amount }, cb) => {
        try {
            // Any manual action resets the player's timeout strike counter.
            resetTimeoutStrike(tableId, user.userId);
            const rtBefore = await (0, runtime_1.getRuntime)(tableId);
            const beforeRound = rtBefore?.round;
            const result = await (0, actions_1.applyTableAction)({ tableId, userId: user.userId, action, amount });
            const state = await (0, table_service_1.getOrBuildTableState)(tableId);
            io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });

            // After any action, the turn/deadline may have changed.
            void scheduleTurnTimer(io, tableId);

            // If the action advanced the betting round (street), it's a safe moment to remove away players.
            const roundAdvanced = !result.handEnded && beforeRound != null && result.runtime && result.runtime.round !== beforeRound;
            if (roundAdvanced) {
                await flushPendingKicks(io, tableId);
            }
            // If the last action ended a betting round and the server has pending board cards,
            // reveal them with a PokerStars-like pacing.
            void (async () => {
                try {
                    const rt = await (0, runtime_1.getRuntime)(tableId);
                    const pending = Array.isArray(rt?.pendingBoard) ? rt.pendingBoard : [];
                    if (rt && rt.isDealingBoard && pending.length) {
                        await revealPendingBoard(io, tableId, () => (0, table_service_1.getOrBuildTableState)(tableId), () => (0, runtime_1.getRuntime)(tableId), (r) => (0, runtime_1.setRuntime)(tableId, r));
                    }
                    // If the hand is in "auto-runout" mode (all-in / no more actions),
                    // keep dealing streets until showdown.
                    const auto = await runAutoRunout(io, tableId, () => (0, table_service_1.getOrBuildTableState)(tableId), () => (0, runtime_1.getRuntime)(tableId), (r) => (0, runtime_1.setRuntime)(tableId, r));
                    if (auto?.showdown) {
                        const sd = auto.showdown;
                        await flushPendingKicks(io, tableId);
                        io.to(`table:${tableId}`).emit("table:event", {
                            type: "SHOWDOWN_REVEAL",
                            tableId,
                            pot: sd.pot,
                            reveal: sd.reveal,
                            winners: sd.winners,
                        });
                        io.to(`table:${tableId}`).emit("table:event", {
                            type: "HAND_ENDED",
                            tableId,
                            winners: sd.winners,
                            pot: sd.pot,
                        });
                        // Auto-start next hand after a short pause so players can see the result.
                        setTimeout(() => {
                            void (async () => {
                                try {
                                    const start = await (0, runtime_1.startHandIfReady)(tableId);
                                    if (start.started && start.runtime) {
                                        const newState = await (0, table_service_1.getOrBuildTableState)(tableId);
                                        io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state: newState });
                                        io.to(`table:${tableId}`).emit("table:event", {
                                            type: "HAND_STARTED",
                                            tableId,
                                            handId: start.runtime.handId,
                                            round: start.runtime.round,
                                        });
                                        for (const p of Object.values(start.runtime.players)) {
                                            const cards = await (0, runtime_1.getPrivateCards)(tableId, start.runtime.handId, p.userId);
                                            if (cards)
                                                io.to(`user:${p.userId}`).emit("table:private_cards", { tableId, handId: start.runtime.handId, cards });
                                        }
                                    }
                                }
                                catch {
                                    // ignore
                                }
                            })();
                        }, SHOWDOWN_HOLD_MS);
                    }
                }
                catch {
                    // ignore
                }
            })();
            if (result.handEnded) {
                await flushPendingKicks(io, tableId);
                let delay = WIN_BY_FOLD_HOLD_MS;
                if (result.winnerSeat != null) {
                    io.to(`table:${tableId}`).emit("table:event", {
                        type: "HAND_ENDED",
                        tableId,
                        winnerSeat: result.winnerSeat,
                    });
                }
                if (result.showdown) {
                    delay = SHOWDOWN_HOLD_MS;
                    const sd = result.showdown;
                    io.to(`table:${tableId}`).emit("table:event", {
                        type: "SHOWDOWN_REVEAL",
                        tableId,
                        pot: sd.pot,
                        reveal: sd.reveal,
                        winners: sd.winners,
                    });
                    io.to(`table:${tableId}`).emit("table:event", {
                        type: "HAND_ENDED",
                        tableId,
                        winners: sd.winners,
                        pot: sd.pot,
                    });
                }
                // Auto-start next hand after a short pause so players can see the result.
                setTimeout(() => {
                    void (async () => {
                        try {
                            const start = await (0, runtime_1.startHandIfReady)(tableId);
                            if (start.started && start.runtime) {
                                const newState = await (0, table_service_1.getOrBuildTableState)(tableId);
                                io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state: newState });
                                io.to(`table:${tableId}`).emit("table:event", {
                                    type: "HAND_STARTED",
                                    tableId,
                                    handId: start.runtime.handId,
                                    round: start.runtime.round,
                                });
                                for (const p of Object.values(start.runtime.players)) {
                                    const cards = await (0, runtime_1.getPrivateCards)(tableId, start.runtime.handId, p.userId);
                                    if (cards)
                                        io.to(`user:${p.userId}`).emit("table:private_cards", { tableId, handId: start.runtime.handId, cards });
                                }
                            }
                        }
                        catch {
                            // ignore
                        }
                    })();
                }, delay);
            }
            cb?.({ ok: true });
        }
        catch (e) {
            const code = e.message ?? "UNKNOWN";
            socket.emit("table:event", { type: "ERROR", code, message: "Invalid action." });
            cb?.({ ok: false, error: { code, message: "Invalid action." } });
        }
    });
}
