"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTableGateway = registerTableGateway;
const table_service_1 = require("../services/table.service");
const wallet_service_1 = require("../services/wallet.service");
const runtime_1 = require("../poker/runtime");
const actions_1 = require("../poker/actions");

// --- Server-timed UX (PokerStars-like pacing) ---
const STREET_PRE_DELAY_MS = 250;
const BOARD_CARD_INTERVAL_MS = 220;
const STREET_POST_DELAY_MS = 350;
const SHOWDOWN_HOLD_MS = 2500;
const WIN_BY_FOLD_HOLD_MS = 1500;
const revealingTables = new Set();
async function revealPendingBoard(io, tableId) {
    if (revealingTables.has(tableId))
        return;
    const rt0 = await (0, runtime_1.getRuntime)(tableId);
    const pending0 = Array.isArray(rt0?.pendingBoard) ? rt0.pendingBoard : [];
    if (!pending0.length)
        return;
    revealingTables.add(tableId);
    try {
        await new Promise((r) => setTimeout(r, STREET_PRE_DELAY_MS));
        while (true) {
            const rt = await (0, runtime_1.getRuntime)(tableId);
            if (!rt)
                break;
            const pending = Array.isArray(rt.pendingBoard) ? rt.pendingBoard : [];
            if (!pending.length)
                break;
            const card = pending.shift();
            rt.board = Array.isArray(rt.board) ? rt.board : [];
            rt.board.push(card);
            rt.pendingBoard = pending;
            await (0, runtime_1.setRuntime)(tableId, rt);
            const state = await (0, table_service_1.getOrBuildTableState)(tableId);
            io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });
            await new Promise((r) => setTimeout(r, BOARD_CARD_INTERVAL_MS));
        }
        const rtFinal = await (0, runtime_1.getRuntime)(tableId);
        if (rtFinal) {
            rtFinal.pendingBoard = [];
            rtFinal.isDealingBoard = false;
            await (0, runtime_1.setRuntime)(tableId, rtFinal);
            const state = await (0, table_service_1.getOrBuildTableState)(tableId);
            io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });
        }
        await new Promise((r) => setTimeout(r, STREET_POST_DELAY_MS));
    }
    finally {
        revealingTables.delete(tableId);
    }
}
function registerTableGateway(io, socket) {
    const user = socket.data.user;
    socket.on("table:join", async ({ tableId }) => {
        await (0, wallet_service_1.ensureWallet)(user.userId);
        socket.join(`table:${tableId}`);
        const state = await (0, table_service_1.getOrBuildTableState)(tableId);
        socket.emit("table:state", state);
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
            const result = await (0, actions_1.applyTableAction)({ tableId, userId: user.userId, action, amount });
            const state = await (0, table_service_1.getOrBuildTableState)(tableId);
            io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });

            // If the server has pending board cards for the next street, reveal them with pacing.
            (async () => {
                try {
                    const rt = await (0, runtime_1.getRuntime)(tableId);
                    const pending = Array.isArray(rt?.pendingBoard) ? rt.pendingBoard : [];
                    if (rt && rt.isDealingBoard && pending.length) {
                        await revealPendingBoard(io, tableId);
                    }
                }
                catch {
                }
            })();
            if (result.handEnded) {
                let delay = WIN_BY_FOLD_HOLD_MS;
                if (result.winnerSeat != null) {
                    io.to(`table:${tableId}`).emit("table:event", { type: "HAND_ENDED", tableId, winnerSeat: result.winnerSeat });
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
                    (async () => {
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
