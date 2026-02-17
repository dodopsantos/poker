"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduleTurnTimer = scheduleTurnTimer;
const runtime_1 = require("./runtime");
const actions_1 = require("./actions");
const table_service_1 = require("../services/table.service");
const runtime_2 = require("./runtime");
// Keep the same UX pacing as the realtime gateway.
// (So the table can show winners / pot result before the next hand.)
const WIN_BY_FOLD_HOLD_MS = Number(process.env.WIN_BY_FOLD_HOLD_MS ?? 1200);
const SHOWDOWN_HOLD_MS = Number(process.env.SHOWDOWN_HOLD_MS ?? 2200);
const timers = new Map();
function timerKey(rt) {
    return `${rt.handId}:${rt.currentTurnSeat}:${rt.turnEndsAt}`;
}
function computeDefaultAction(rt, seatNo) {
    const p = rt.players?.[seatNo];
    if (!p)
        return "FOLD";
    const toCall = Math.max(0, (rt.currentBet ?? 0) - (p.bet ?? 0));
    // If nothing to call, auto-check; otherwise auto-fold.
    return toCall === 0 ? "CHECK" : "FOLD";
}
async function scheduleTurnTimer(io, tableId) {
    const rt = await (0, runtime_1.getRuntime)(tableId);
    if (!rt) {
        // no hand running -> clear any pending timer
        const existing = timers.get(tableId);
        if (existing) {
            clearTimeout(existing.timeout);
            timers.delete(tableId);
        }
        return;
    }
    const key = timerKey(rt);
    const existing = timers.get(tableId);
    if (existing && existing.key === key)
        return; // already scheduled for this exact turn
    if (existing) {
        clearTimeout(existing.timeout);
        timers.delete(tableId);
    }
    const delay = Math.max(0, (rt.turnEndsAt ?? Date.now()) - Date.now());
    const timeout = setTimeout(async () => {
        try {
            const latest = await (0, runtime_1.getRuntime)(tableId);
            if (!latest)
                return;
            // Ignore if turn changed
            if (timerKey(latest) !== key)
                return;
            const seatNo = latest.currentTurnSeat;
            const p = latest.players?.[seatNo];
            if (!p)
                return;
            const action = computeDefaultAction(latest, seatNo);
            const result = await (0, actions_1.applyTableAction)({
                tableId,
                userId: p.userId,
                action,
            });
            const state = await (0, table_service_1.getOrBuildTableState)(tableId);
            io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });
            if (result.handEnded) {
                // When the hand ends via timeout, clients still expect the same events
                // (HAND_ENDED / SHOWDOWN_REVEAL) as when a player clicks an action.
                let delay = WIN_BY_FOLD_HOLD_MS;
                if (result.winnerSeat != null) {
                    io.to(`table:${tableId}`).emit("table:event", {
                        type: "HAND_ENDED",
                        tableId,
                        winnerSeat: result.winnerSeat,
                        winners: result.winnerUserId
                            ? [{ seatNo: result.winnerSeat, userId: result.winnerUserId, payout: result.payout ?? 0 }]
                            : undefined,
                        pot: result.payout ?? undefined,
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
                // Auto-start next hand after a short pause (same as gateway)
                setTimeout(() => {
                    void (async () => {
                        try {
                            const start = await (0, runtime_2.startHandIfReady)(tableId);
                            if (start.started && start.runtime) {
                                const newState = await (0, table_service_1.getOrBuildTableState)(tableId);
                                io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state: newState });
                                io.to(`table:${tableId}`).emit("table:event", {
                                    type: "HAND_STARTED",
                                    tableId,
                                    handId: start.runtime.handId,
                                    round: start.runtime.round,
                                });
                                for (const pl of Object.values(start.runtime.players)) {
                                    const cards = await (0, runtime_2.getPrivateCards)(tableId, start.runtime.handId, pl.userId);
                                    if (cards)
                                        io.to(`user:${pl.userId}`).emit("table:private_cards", { tableId, handId: start.runtime.handId, cards });
                                }
                            }
                        }
                        catch {
                            // ignore
                        }
                    })();
                }, delay);
            }
            // Schedule next turn if still running
            await scheduleTurnTimer(io, tableId);
        }
        catch {
            // swallow
        }
    }, delay);
    timers.set(tableId, { key, timeout });
}
