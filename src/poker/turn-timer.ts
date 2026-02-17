import type { Server } from "socket.io";
import { getRuntime } from "./runtime";
import { applyTableAction } from "./actions";
import { getOrBuildTableState } from "../services/table.service";
import { startHandIfReady, getPrivateCards } from "./runtime";

// Keep the same UX pacing as the realtime gateway.
// (So the table can show winners / pot result before the next hand.)
const WIN_BY_FOLD_HOLD_MS = Number(process.env.WIN_BY_FOLD_HOLD_MS ?? 1200);
const SHOWDOWN_HOLD_MS = Number(process.env.SHOWDOWN_HOLD_MS ?? 2200);

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
        // When the hand ends via timeout, clients still expect the same events
        // (HAND_ENDED / SHOWDOWN_REVEAL) as when a player clicks an action.
        let delay = WIN_BY_FOLD_HOLD_MS;

        if ((result as any).winnerSeat != null) {
          io.to(`table:${tableId}`).emit("table:event", {
            type: "HAND_ENDED",
            tableId,
            winnerSeat: (result as any).winnerSeat,
            // Optional richer payload for UI (PokerStars-like)
            winners: (result as any).winnerUserId
              ? [{ seatNo: (result as any).winnerSeat, userId: (result as any).winnerUserId, payout: (result as any).payout ?? 0 }]
              : undefined,
            pot: (result as any).payout ?? undefined,
          });
        }

        if ((result as any).showdown) {
          delay = SHOWDOWN_HOLD_MS;
          const sd = (result as any).showdown;

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
            } catch {
              // ignore
            }
          })();
        }, delay);
      }

      // Schedule next turn if still running
      await scheduleTurnTimer(io, tableId);
    } catch {
      // swallow
    }
  }, delay);

  timers.set(tableId, { key, timeout });
}
