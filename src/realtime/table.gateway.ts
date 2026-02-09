import type { Server, Socket } from "socket.io";
import { getOrBuildTableState, sitWithBuyIn, leaveWithCashout } from "../services/table.service";
import { ensureWallet } from "../services/wallet.service";
import { startHandIfReady, getPrivateCards, getRuntime, setRuntime } from "../poker/runtime";
import { applyTableAction, advanceAutoRunout, type PlayerAction } from "../poker/actions";

// --- Server-timed UX (PokerStars-like pacing) ---
// Board dealing (flop/turn/river) reveal timings
const STREET_PRE_DELAY_MS = 250;
const BOARD_CARD_INTERVAL_MS = 220;
const STREET_POST_DELAY_MS = 350;

// Hand end pacing
const SHOWDOWN_HOLD_MS = 2500;
const WIN_BY_FOLD_HOLD_MS = 1500;

// In-memory per-table reveal lock to avoid overlapping reveal sequences.
const revealingTables = new Set<string>();

async function revealPendingBoard(
  io: Server,
  tableId: string,
  getState: () => Promise<any>,
  getRt: () => Promise<any>,
  setRt: (rt: any) => Promise<void>
): Promise<void> {
  if (revealingTables.has(tableId)) return;

  const rt0 = await getRt();
  const pending: string[] = Array.isArray(rt0?.pendingBoard) ? rt0.pendingBoard : [];
  if (!pending.length) return;

  revealingTables.add(tableId);
  try {
    // Small pause before the first card appears.
    await new Promise((r) => setTimeout(r, STREET_PRE_DELAY_MS));

    for (let i = 0; i < pending.length; i++) {
      const rt = await getRt();
      const cards: string[] = Array.isArray(rt?.pendingBoard) ? rt.pendingBoard : [];
      if (!cards.length) break;

      const card = cards.shift()!;
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
      await setRt(rtFinal);
      const state = await getState();
      io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });
    }

    await new Promise((r) => setTimeout(r, STREET_POST_DELAY_MS));
  } finally {
    revealingTables.delete(tableId);
  }
}

async function runAutoRunout(
  io: Server,
  tableId: string,
  getState: () => Promise<any>,
  getRt: () => Promise<any>,
  setRt: (rt: any) => Promise<void>
): Promise<
  | null
  | {
      showdown: {
        pot: number;
        reveal: Array<{ seatNo: number; userId: string; cards: string[] }>;
        winners: Array<{ seatNo: number; userId: string; payout: number }>;
      };
    }
> {
  // Keep advancing streets while auto-runout is enabled.
  for (let guard = 0; guard < 10; guard++) {
    const step = await advanceAutoRunout(tableId);
    if (!step) return null;

    const state = await getState();
    io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });

    if ((step as any).handEnded && (step as any).showdown) {
      return { showdown: (step as any).showdown };
    }

    const rt = await getRt();
    const pending = Array.isArray((rt as any)?.pendingBoard) ? ((rt as any).pendingBoard as string[]) : [];
    if (rt && (rt as any).isDealingBoard && pending.length) {
      await revealPendingBoard(io, tableId, getState, getRt, setRt);
      // Loop again after the reveal.
      continue;
    }

    // Nothing left to do.
    return null;
  }

  return null;
}

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

        // If the last action ended a betting round and the server has pending board cards,
        // reveal them with a PokerStars-like pacing.
        void (async () => {
          try {
            const rt = await getRuntime(tableId);
            const pending = Array.isArray((rt as any)?.pendingBoard) ? ((rt as any).pendingBoard as string[]) : [];
            if (rt && (rt as any).isDealingBoard && pending.length) {
              await revealPendingBoard(
                io,
                tableId,
                () => getOrBuildTableState(tableId),
                () => getRuntime(tableId),
                (r) => setRuntime(tableId, r)
              );
            }

            // If the hand is in "auto-runout" mode (all-in / no more actions),
            // keep dealing streets until showdown.
            const auto = await runAutoRunout(
              io,
              tableId,
              () => getOrBuildTableState(tableId),
              () => getRuntime(tableId),
              (r) => setRuntime(tableId, r)
            );

            if (auto?.showdown) {
              const sd = auto.showdown;

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
                        if (cards)
                          io.to(`user:${p.userId}`).emit("table:private_cards", { tableId, handId: start.runtime.handId, cards });
                      }
                    }
                  } catch {
                    // ignore
                  }
                })();
              }, SHOWDOWN_HOLD_MS);
            }
          } catch {
            // ignore
          }
        })();

        if (result.handEnded) {
          let delay = WIN_BY_FOLD_HOLD_MS;

          if ((result as any).winnerSeat != null) {
            io.to(`table:${tableId}`).emit("table:event", {
              type: "HAND_ENDED",
              tableId,
              winnerSeat: (result as any).winnerSeat,
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

          // Auto-start next hand after a short pause so players can see the result.
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

                  for (const p of Object.values(start.runtime.players)) {
                    const cards = await getPrivateCards(tableId, start.runtime.handId, p.userId);
                    if (cards) io.to(`user:${p.userId}`).emit("table:private_cards", { tableId, handId: start.runtime.handId, cards });
                  }
                }
              } catch {
                // ignore
              }
            })();
          }, delay);
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
