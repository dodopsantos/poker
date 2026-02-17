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
const TURN_TIME_MS = Number(process.env.TURN_TIME_MS ?? 15000);
const AWAY_TIMEOUTS_IN_ROW = Number(process.env.AWAY_TIMEOUTS_IN_ROW ?? 2);

// In-memory per-table reveal lock to avoid overlapping reveal sequences.
const revealingTables = new Set<string>();

// In-memory per-table turn timer. The backend is authoritative:
// when the turn expires we auto-check (if toCall==0) or auto-fold (if toCall>0).
const turnTimers = new Map<string, NodeJS.Timeout>();

// Track consecutive timeouts per user per table (in-memory, resets on any manual action).
const timeoutStrikes = new Map<string, Map<string, number>>();

// Players that exceeded the timeout limit are only removed (cashout) when a betting round ends
// (i.e., when the game advances to the next street) or when the hand ends.
const pendingAwayKick = new Map<string, Set<string>>(); // tableId -> userIds

function markPendingKick(tableId: string, userId: string) {
  const set = pendingAwayKick.get(tableId) ?? new Set<string>();
  set.add(userId);
  pendingAwayKick.set(tableId, set);
}

function clearPendingKick(tableId: string, userId: string) {
  pendingAwayKick.get(tableId)?.delete(userId);
}

async function flushPendingKicks(io: Server, tableId: string) {
  const set = pendingAwayKick.get(tableId);
  if (!set || set.size === 0) return;

  let newState: any | null = null;
  for (const uid of Array.from(set)) {
    try {
      newState = await leaveWithCashout({ tableId, userId: uid });
      // Reset strike counter and clear pending flag after cashout.
      resetTimeoutStrike(tableId, uid);
      clearPendingKick(tableId, uid);
    } catch {
      // If cashout fails (e.g., player already left), just clear the pending flag.
      clearPendingKick(tableId, uid);
    }
  }

  if (newState) {
    io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state: newState });
    io.to("lobby").emit("lobby:table_updated", { tableId });
  }
}

function incTimeoutStrike(tableId: string, userId: string): number {
  const m = timeoutStrikes.get(tableId) ?? new Map<string, number>();
  const next = (m.get(userId) ?? 0) + 1;
  m.set(userId, next);
  timeoutStrikes.set(tableId, m);
  return next;
}

function resetTimeoutStrike(tableId: string, userId: string) {
  const m = timeoutStrikes.get(tableId);
  if (!m) return;
  m.set(userId, 0);
}

function clearTurnTimer(tableId: string) {
  const t = turnTimers.get(tableId);
  if (t) clearTimeout(t);
  turnTimers.delete(tableId);
}

async function scheduleTurnTimer(io: Server, tableId: string) {
  clearTurnTimer(tableId);

  const rt = await getRuntime(tableId);
  if (!rt) return;

  // No actions allowed while revealing board cards.
  if ((rt as any).isDealingBoard) return;
  // No actions during auto-runout; board will be dealt to showdown.
  if ((rt as any).autoRunout) return;

  const endsAt = Number((rt as any).turnEndsAt ?? NaN);
  if (!Number.isFinite(endsAt) || endsAt <= 0) return;

  const delay = Math.max(0, endsAt - Date.now());

  const timer = setTimeout(() => {
    void (async () => {
      try {
        const rt2 = await getRuntime(tableId);
        if (!rt2) return;
        if ((rt2 as any).isDealingBoard) return;
        if ((rt2 as any).autoRunout) return;

        const endsAt2 = Number((rt2 as any).turnEndsAt ?? NaN);
        // If turn changed / timer reset, ignore this timeout.
        if (!Number.isFinite(endsAt2) || endsAt2 !== endsAt) return;

        const seatNo = rt2.currentTurnSeat;
        const seat = (rt2 as any).players?.[seatNo];
        if (!seat || seat.hasFolded) return;

        const beforeRound = rt2.round;

        const toCall = Math.max(0, (rt2.currentBet ?? 0) - (seat.bet ?? 0));
        const forced: PlayerAction = toCall === 0 ? "CHECK" : "FOLD";

        // Count this as a timeout strike for this user.
        const strikes = incTimeoutStrike(tableId, seat.userId);

        // If the player reached the strike limit, mark them to be removed at the end of the betting round.
        if (strikes >= AWAY_TIMEOUTS_IN_ROW) {
          markPendingKick(tableId, seat.userId);
        }

        const result = await applyTableAction({ tableId, userId: seat.userId, action: forced, timeout: true });

        const state = await getOrBuildTableState(tableId);
        io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });

        // Only remove "away" players when a betting round ends (street advances) or when the hand ends.
        const roundAdvanced = !((result as any).handEnded) && (result as any).runtime && (result as any).runtime.round !== beforeRound;
        if (roundAdvanced) {
          await flushPendingKicks(io, tableId);
        }

        // If the timeout ended the hand by everyone folding, broadcast and start next hand with pacing.
        if ((result as any).handEnded && (result as any).winnerSeat != null) {
          // Hand ended -> safe moment to kick away players.
          await flushPendingKicks(io, tableId);
          const r = result as { handEnded: true; winnerSeat: number; winnerUserId: string; payout: number };

          io.to(`table:${tableId}`).emit("table:event", {
            type: "HAND_ENDED",
            tableId,
            winners: [{ seatNo: r.winnerSeat, userId: r.winnerUserId, payout: r.payout }],
            pot: r.payout,
          });

          clearTurnTimer(tableId);

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
                    const cards = await getPrivateCards(tableId, start.runtime.handId, (p as any).userId);
                    if (cards)
                      io.to(`user:${(p as any).userId}`).emit("table:private_cards", {
                        tableId,
                        handId: start.runtime.handId,
                        cards,
                      });
                  }
                  void scheduleTurnTimer(io, tableId);
                }
              } catch {
                // ignore
              }
            })();
          }, WIN_BY_FOLD_HOLD_MS);

          return;
        }

        // If we ended a betting round and queued board cards, reveal them.
        void (async () => {
          try {
            const rta = await getRuntime(tableId);
            const pending = Array.isArray((rta as any)?.pendingBoard) ? ((rta as any).pendingBoard as string[]) : [];
            if (rta && (rta as any).isDealingBoard && pending.length) {
              await revealPendingBoard(
                io,
                tableId,
                () => getOrBuildTableState(tableId),
                () => getRuntime(tableId),
                (r) => setRuntime(tableId, r)
              );
            }

            const auto = await runAutoRunout(
              io,
              tableId,
              () => getOrBuildTableState(tableId),
              () => getRuntime(tableId),
              (r) => setRuntime(tableId, r)
            );

            if (auto?.showdown) {
              const sd = auto.showdown;

              // Hand ended -> safe moment to kick away players.
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
                        const cards = await getPrivateCards(tableId, start.runtime.handId, (p as any).userId);
                        if (cards)
                          io.to(`user:${(p as any).userId}`).emit("table:private_cards", {
                            tableId,
                            handId: start.runtime.handId,
                            cards,
                          });
                      }
                    }
                  } catch {
                    // ignore
                  }
                })();
              }, SHOWDOWN_HOLD_MS);
              return;
            }
          } catch {
            // ignore
          }
        })();

        // If hand ended here, we must emit the same end-of-hand events and schedule the next hand.
        if ((result as any).handEnded) {
          clearTurnTimer(tableId);

          // Showdown end is handled above by the auto-runout sequence.
          // Here we handle win-by-fold (common when timeout forces a fold).
          if ((result as any).winnerSeat != null) {
            const r = result as { handEnded: true; winnerSeat: number; winnerUserId: string; payout: number };
            io.to(`table:${tableId}`).emit("table:event", {
              type: "HAND_ENDED",
              tableId,
              winners: [{ seatNo: r.winnerSeat, userId: r.winnerUserId, payout: r.payout }],
              pot: r.payout,
            });

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
                      const cards = await getPrivateCards(tableId, start.runtime.handId, (p as any).userId);
                      if (cards)
                        io.to(`user:${(p as any).userId}`).emit("table:private_cards", {
                          tableId,
                          handId: start.runtime.handId,
                          cards,
                        });
                    }
                  }
                } catch {
                  // ignore
                }
              })();
            }, WIN_BY_FOLD_HOLD_MS);
          }
          return;
        }

        // Otherwise, schedule the next player's deadline.
        await scheduleTurnTimer(io, tableId);
      } catch {
        // ignore
      }
    })();
  }, delay + 20);

  turnTimers.set(tableId, timer);
}

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

      // Actions become available again: start a fresh turn deadline (unless auto-runout).
      if (!(rtFinal as any).autoRunout) {
        (rtFinal as any).turnEndsAt = Date.now() + TURN_TIME_MS;
      }

      await setRt(rtFinal);
      const state = await getState();
      io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });

      // NOTE: scheduleTurnTimer is NOT called here intentionally.
      // The caller (table:action / timeout handler) always calls runAutoRunout after revealPendingBoard,
      // and runAutoRunout will schedule the timer once. Calling it here too would create a race condition
      // where two timers exist simultaneously for the same turn.
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

    // If auto-runout stops (e.g., multi-way side pot re-opens action), this will schedule the next turn.
    void scheduleTurnTimer(io, tableId);

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

    // Ensure turn timer is scheduled for this table (server authoritative).
    void scheduleTurnTimer(io, tableId);

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
            const cards = await getPrivateCards(tableId, start.runtime.handId, p.userId);
            if (cards) io.to(`user:${p.userId}`).emit("table:private_cards", { tableId, handId: start.runtime.handId, cards });
          }

          // Hand started sets a new turn/deadline in runtime; schedule the timer.
          void scheduleTurnTimer(io, tableId);
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
        // Any manual action resets the player's timeout strike counter.
        resetTimeoutStrike(tableId, user.userId);

        // Capture the betting round before applying the action so we can detect street advances.
        const rtBefore = await getRuntime(tableId);
        const beforeRound = rtBefore?.round;
        const result = await applyTableAction({ tableId, userId: user.userId, action, amount });

        const state = await getOrBuildTableState(tableId);
        io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });

        // After any action, the turn/deadline may have changed.
        void scheduleTurnTimer(io, tableId);

        // If the action advanced the betting round (street), it's a safe moment to remove away players.
        const roundAdvanced =
          !result.handEnded &&
          beforeRound != null &&
          (result as any).runtime &&
          (result as any).runtime.round !== beforeRound;
        if (roundAdvanced) {
          await flushPendingKicks(io, tableId);
        }

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

              // Hand ended -> safe moment to kick away players.
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
          // Hand ended -> safe moment to kick away players.
          await flushPendingKicks(io, tableId);
          let delay = WIN_BY_FOLD_HOLD_MS;

          if ((result as any).winnerSeat != null) {
            const r = result as { handEnded: true; winnerSeat: number; winnerUserId: string; payout: number };
            io.to(`table:${tableId}`).emit("table:event", {
              type: "HAND_ENDED",
              tableId,
              winners: [{ seatNo: r.winnerSeat, userId: r.winnerUserId, payout: r.payout }],
              pot: r.payout,
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
