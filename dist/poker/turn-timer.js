"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduleTurnTimer = scheduleTurnTimer;

const runtime_1 = require("./runtime");
const actions_1 = require("./actions");
const table_service_1 = require("../services/table.service");

const timers = new Map();

function timerKey(rt) {
  return `${rt.handId}:${rt.currentTurnSeat}:${rt.turnEndsAt}`;
}

function computeDefaultAction(rt, seatNo) {
  const p = rt.players?.[seatNo];
  if (!p) return "FOLD";
  const toCall = Math.max(0, (rt.currentBet ?? 0) - (p.bet ?? 0));
  return toCall === 0 ? "CHECK" : "FOLD";
}

async function scheduleTurnTimer(io, tableId) {
  const rt = await (0, runtime_1.getRuntime)(tableId);
  if (!rt) {
    const existing = timers.get(tableId);
    if (existing) {
      clearTimeout(existing.timeout);
      timers.delete(tableId);
    }
    return;
  }

  const key = timerKey(rt);

  const existing = timers.get(tableId);
  if (existing && existing.key === key) return;

  if (existing) {
    clearTimeout(existing.timeout);
    timers.delete(tableId);
  }

  const delay = Math.max(0, (rt.turnEndsAt ?? Date.now()) - Date.now());

  const timeout = setTimeout(async () => {
    try {
      const latest = await (0, runtime_1.getRuntime)(tableId);
      if (!latest) return;
      if (timerKey(latest) !== key) return;

      const seatNo = latest.currentTurnSeat;
      const p = latest.players?.[seatNo];
      if (!p) return;

      const action = computeDefaultAction(latest, seatNo);

      const result = await (0, actions_1.applyTableAction)({ tableId, userId: p.userId, action });

      const state = await (0, table_service_1.getOrBuildTableState)(tableId);
      io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });

      if (result.handEnded) {
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

          for (const pl of Object.values(start.runtime.players)) {
            const cards = await (0, runtime_1.getPrivateCards)(tableId, start.runtime.handId, pl.userId);
            if (cards) io.to(`user:${pl.userId}`).emit("table:private_cards", { tableId, handId: start.runtime.handId, cards });
          }
        }
      }

      await scheduleTurnTimer(io, tableId);
    } catch {}
  }, delay);

  timers.set(tableId, { key, timeout });
}
