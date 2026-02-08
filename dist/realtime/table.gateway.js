"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTableGateway = registerTableGateway;
const table_service_1 = require("../services/table.service");
const wallet_service_1 = require("../services/wallet.service");
const runtime_1 = require("../poker/runtime");
const actions_1 = require("../poker/actions");
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
            if (result.handEnded) {
                if (result.winnerSeat != null) {
                    io.to(`table:${tableId}`).emit("table:event", { type: "HAND_ENDED", tableId, winnerSeat: result.winnerSeat });
                }
                if (result.showdown) {
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
                // Auto-start next hand (if still 2+ players seated)
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
            cb?.({ ok: true });
        }
        catch (e) {
            const code = e.message ?? "UNKNOWN";
            socket.emit("table:event", { type: "ERROR", code, message: "Invalid action." });
            cb?.({ ok: false, error: { code, message: "Invalid action." } });
        }
    });
}
