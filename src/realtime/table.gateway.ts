import type { Server, Socket } from "socket.io";
import { getOrBuildTableState, sitWithBuyIn, leaveWithCashout } from "../services/table.service";
import { ensureWallet } from "../services/wallet.service";
import { startHandIfReady, getPrivateCards } from "../poker/runtime";
import { applyTableAction, type PlayerAction } from "../poker/actions";

export function registerTableGateway(io: Server, socket: Socket) {
  const user = (socket.data as any).user as { userId: string; username: string };

  socket.on("table:join", async ({ tableId }: { tableId: string }) => {
    await ensureWallet(user.userId);
    socket.join(`table:${tableId}`);

    const state = await getOrBuildTableState(tableId);
    socket.emit("table:state", state);

    // If there's a running hand and the user is seated, send private cards
    if (state.game?.handId) {
      const cards = await getPrivateCards(tableId, state.game.handId, user.userId);
      if (cards) socket.emit("table:private_cards", { tableId, handId: state.game.handId, cards });
    }
  });

  socket.on(
    "table:sit",
    async ({ tableId, seatNo, buyInAmount }: { tableId: string; seatNo: number; buyInAmount: number }) => {
      try {
        const stateAfterSit = await sitWithBuyIn({ tableId, userId: user.userId, seatNo, buyInAmount });

        // Maybe start a hand
        const start = await startHandIfReady(tableId);
        const state = await getOrBuildTableState(tableId);

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
            const cards = await getPrivateCards(tableId, start.runtime.handId, p.userId);
            if (cards) io.to(`user:${p.userId}`).emit("table:private_cards", { tableId, handId: start.runtime.handId, cards });
          }
        }

        io.to("lobby").emit("lobby:table_updated", { tableId });
      } catch (e: any) {
        socket.emit("table:event", { type: "ERROR", code: e.message ?? "UNKNOWN", message: "Could not sit." });
      }
    }
  );

  socket.on("table:leave", async ({ tableId }: { tableId: string }) => {
    try {
      const newState = await leaveWithCashout({ tableId, userId: user.userId });
      io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state: newState });
      io.to("lobby").emit("lobby:table_updated", { tableId });
    } catch (e: any) {
      socket.emit("table:event", { type: "ERROR", code: e.message ?? "UNKNOWN", message: "Could not leave." });
    }
  });

  socket.on(
    "table:action",
    async (
      { tableId, action, amount }: { tableId: string; action: PlayerAction; amount?: number },
      cb?: (ack: { ok: boolean; error?: { code: string; message: string } }) => void
    ) => {
      try {
        const result = await applyTableAction({ tableId, userId: user.userId, action, amount });

        const state = await getOrBuildTableState(tableId);
        io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });

        if (result.handEnded) {
          if ((result as any).winnerSeat != null) {
            io.to(`table:${tableId}`).emit("table:event", { type: "HAND_ENDED", tableId, winnerSeat: (result as any).winnerSeat });
          }
          if ((result as any).showdown) {
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

          // Auto-start next hand (if still 2+ players seated)
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

            for (const p of Object.values(start.runtime.players)) {
              const cards = await getPrivateCards(tableId, start.runtime.handId, p.userId);
              if (cards) io.to(`user:${p.userId}`).emit("table:private_cards", { tableId, handId: start.runtime.handId, cards });
            }
          }
        }

        cb?.({ ok: true });
      } catch (e: any) {
        const code = e.message ?? "UNKNOWN";
        socket.emit("table:event", { type: "ERROR", code, message: "Invalid action." });
        cb?.({ ok: false, error: { code, message: "Invalid action." } });
      }
    }
  );
}
