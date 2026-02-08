import type { Server } from "socket.io";
import { getRuntime } from "./runtime";
import { applyTableAction } from "./actions";
import { getOrBuildTableState } from "../services/table.service";
import { startHandIfReady, getPrivateCards } from "./runtime";

const timers = new Map<string, { key: string; timeout: NodeJS.Timeout }>();

function timerKey(rt: any) {
  return `${rt.handId}:${rt.currentTurnSeat}:${rt.turnEndsAt}`;
}

function computeDefaultAction(rt: any, seatNo: number) {
  const p = rt.players?.[seatNo];
  if (!p) return "FOLD" as const;
  const toCall = Math.max(0, (rt.currentBet ?? 0) - (p.bet ?? 0));
  // If nothing to call, auto-check; otherwise auto-fold.
  return toCall === 0 ? ("CHECK" as const) : ("FOLD" as const);
}

export async function scheduleTurnTimer(io: Server, tableId: string) {
  const rt = await getRuntime(tableId);
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
  if (existing && existing.key === key) return; // already scheduled for this exact turn

  if (existing) {
    clearTimeout(existing.timeout);
    timers.delete(tableId);
  }

  const delay = Math.max(0, (rt.turnEndsAt ?? Date.now()) - Date.now());

  const timeout = setTimeout(async () => {
    try {
      const latest = await getRuntime(tableId);
      if (!latest) return;

      // Ignore if turn changed
      if (timerKey(latest) !== key) return;

      const seatNo = latest.currentTurnSeat;
      const p = latest.players?.[seatNo];
      if (!p) return;

      const action = computeDefaultAction(latest, seatNo);

      const result = await applyTableAction({
        tableId,
        userId: p.userId,
        action,
      });

      const state = await getOrBuildTableState(tableId);
      io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });

      if (result.handEnded) {
        // Auto-start next hand if possible (same behavior as manual actions)
        const start = await startHandIfReady(tableId);
        if (start.started && start.runtime) {
          const newState = await getOrBuildTableState(tableId);
          io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state: newState });
          io.to(`table:${tableId}`).emit("table:event", {
            type: "HAND_STARTED",
            tableId,
            handId: start.runtime.handId,
            round: start.runtime.round,
          });

          for (const pl of Object.values(start.runtime.players)) {
            const cards = await getPrivateCards(tableId, start.runtime.handId, (pl as any).userId);
            if (cards) io.to(`user:${(pl as any).userId}`).emit("table:private_cards", { tableId, handId: start.runtime.handId, cards });
          }
        }
      }

      // Schedule next turn if still running
      await scheduleTurnTimer(io, tableId);
    } catch {
      // swallow
    }
  }, delay);

  timers.set(tableId, { key, timeout });
}
