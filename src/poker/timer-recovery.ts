/**
 * timer-recovery.ts
 *
 * On server boot (or restart), all in-memory turn timers are gone.
 * Any table that had a running hand is now stuck — the runtime exists in Redis
 * but nobody will advance the turn.
 *
 * This module scans Redis for all active runtimes and reschedules the timers,
 * so in-progress hands resume correctly after a crash or deploy.
 */

import type { Server } from "socket.io";
import { redis } from "../redis";
import { getRuntime } from "./runtime";
import { scheduleTurnTimer } from "../realtime/table.gateway";
import { getOrBuildTableState } from "../services/table.service";

/**
 * Scans Redis for all active table runtimes and reschedules their turn timers.
 * Call this once after the HTTP server starts listening.
 */
export async function recoverActiveTimers(io: Server): Promise<void> {
  console.log("[timer-recovery] Scanning for active table runtimes...");

  const tableIds = await scanActiveTableIds();

  if (tableIds.length === 0) {
    console.log("[timer-recovery] No active runtimes found.");
    return;
  }

  console.log(`[timer-recovery] Found ${tableIds.length} active runtime(s): ${tableIds.join(", ")}`);

  let recovered = 0;
  let stale = 0;

  for (const tableId of tableIds) {
    try {
      const rt = await getRuntime(tableId);
      if (!rt) {
        stale++;
        continue;
      }

      // Emit a fresh snapshot to any clients already connected to this table room.
      // (Useful if the server bounced quickly and clients are still connected via WS.)
      const state = await getOrBuildTableState(tableId);
      io.to(`table:${tableId}`).emit("table:event", {
        type: "STATE_SNAPSHOT",
        tableId,
        state,
      });

      // Reschedule the turn timer. scheduleTurnTimer reads turnEndsAt from the
      // runtime and sets the correct remaining delay, so turns that were almost
      // expired will fire quickly — effectively the correct behaviour post-crash.
      await scheduleTurnTimer(io, tableId);

      recovered++;
      console.log(
        `[timer-recovery] Recovered tableId=${tableId} handId=${rt.handId} round=${rt.round} turnSeat=${rt.currentTurnSeat}`
      );
    } catch (err) {
      console.error(`[timer-recovery] Failed to recover tableId=${tableId}:`, err);
    }
  }

  console.log(
    `[timer-recovery] Done. recovered=${recovered} stale=${stale} total=${tableIds.length}`
  );
}

/**
 * Uses Redis SCAN to find all keys matching "table:*:runtime".
 * SCAN is non-blocking and safe for production (unlike KEYS).
 */
async function scanActiveTableIds(): Promise<string[]> {
  const tableIds: string[] = [];
  let cursor = "0";

  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      "table:*:runtime",
      "COUNT",
      100
    );
    cursor = nextCursor;

    for (const key of keys) {
      // key format: "table:{tableId}:runtime"
      const parts = key.split(":");
      if (parts.length === 3 && parts[0] === "table" && parts[2] === "runtime") {
        tableIds.push(parts[1]);
      }
    }
  } while (cursor !== "0");

  return tableIds;
}
