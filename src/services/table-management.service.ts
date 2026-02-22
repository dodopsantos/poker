/**
 * Table management service - cleanup automático e uma mesa por jogador
 */

import { prisma } from "../prisma";
import { clearRuntime } from "../poker/runtime";
import type { Server } from "socket.io";

/**
 * Verifica se a mesa está vazia e faz cleanup se necessário
 */
export async function checkAndCleanupEmptyTable(io: Server, tableId: string): Promise<boolean> {
  try {
    // Buscar todos os seats da mesa
    const seats = await prisma.tableSeat.findMany({
      where: { tableId },
    });

    // Verificar se há algum player sentado
    const hasPlayers = seats.some((s) => s.state !== "EMPTY" && s.userId !== null);

    if (!hasPlayers) {
      console.log(`[table-mgmt] Table ${tableId} is empty, cleaning up...`);

      // Limpar runtime (Redis)
      await clearRuntime(tableId);

      // Resetar status da mesa para OPEN
      await prisma.table.update({
        where: { id: tableId },
        data: { status: "OPEN" },
      });

      // Notificar lobby
      io.to("lobby").emit("lobby:table_updated", { tableId });

      console.log(`[table-mgmt] Table ${tableId} cleaned up successfully`);
      return true;
    }

    return false;
  } catch (err) {
    console.error(`[table-mgmt] Error cleaning up table ${tableId}:`, err);
    return false;
  }
}

/**
 * Remove jogador de todas as mesas (exceto a especificada)
 * Usado para garantir que player só esteja em uma mesa por vez
 */
export async function removePlayerFromOtherTables(
  io: Server,
  userId: string,
  currentTableId?: string
): Promise<void> {
  try {
    // Buscar todas as mesas onde o usuário está sentado
    const seats = await prisma.tableSeat.findMany({
      where: {
        userId,
        state: { in: ["SITTING", "PLAYING"] },
        ...(currentTableId ? { tableId: { not: currentTableId } } : {}),
      },
      include: { table: true },
    });

    if (seats.length === 0) {
      return;
    }

    console.log(`[table-mgmt] User ${userId} found in ${seats.length} other table(s), removing...`);

    for (const seat of seats) {
      const tableId = seat.tableId;

      // Cashout do jogador
      const cashoutAmount = seat.stack;
      
      if (cashoutAmount > 0) {
        // Devolver stack para a wallet
        await prisma.wallet.update({
          where: { userId },
          data: { balance: { increment: cashoutAmount } },
        });

        // Registrar transação
        await prisma.ledgerTransaction.create({
          data: {
            userId,
            tableId,
            type: "CASHOUT",
            amount: cashoutAmount,
          },
        });
      }

      // Limpar seat
      await prisma.tableSeat.update({
        where: { id: seat.id },
        data: {
          userId: null,
          stack: 0,
          state: "EMPTY",
        },
      });

      // Notificar mesa
      io.to(`table:${tableId}`).emit("table:event", {
        type: "PLAYER_LEFT",
        tableId,
        seatNo: seat.seatNo,
        userId,
      });

      // Verificar se mesa ficou vazia
      await checkAndCleanupEmptyTable(io, tableId);

      console.log(`[table-mgmt] User ${userId} removed from table ${tableId} (cashout: ${cashoutAmount})`);
    }
  } catch (err) {
    console.error(`[table-mgmt] Error removing player from other tables:`, err);
  }
}

/**
 * Força remoção de um jogador de uma mesa específica
 * Usado para cleanup de disconnect, timeout, etc
 */
export async function forceRemovePlayer(
  io: Server,
  tableId: string,
  userId: string,
  reason: "disconnect" | "timeout" | "idle" | "admin" = "disconnect"
): Promise<void> {
  try {
    const seat = await prisma.tableSeat.findFirst({
      where: {
        tableId,
        userId,
        state: { in: ["SITTING", "PLAYING"] },
      },
    });

    if (!seat) {
      return; // Jogador já não está na mesa
    }

    console.log(`[table-mgmt] Force removing user ${userId} from table ${tableId} (reason: ${reason})`);

    // Cashout
    const cashoutAmount = seat.stack;
    
    if (cashoutAmount > 0) {
      await prisma.wallet.update({
        where: { userId },
        data: { balance: { increment: cashoutAmount } },
      });

      await prisma.ledgerTransaction.create({
        data: {
          userId,
          tableId,
          type: "CASHOUT",
          amount: cashoutAmount,
        },
      });
    }

    // Limpar seat
    await prisma.tableSeat.update({
      where: { id: seat.id },
      data: {
        userId: null,
        stack: 0,
        state: "EMPTY",
      },
    });

    // Notificar mesa
    io.to(`table:${tableId}`).emit("table:event", {
      type: "PLAYER_REMOVED",
      tableId,
      seatNo: seat.seatNo,
      userId,
      reason,
    });

    // Verificar cleanup
    await checkAndCleanupEmptyTable(io, tableId);
  } catch (err) {
    console.error(`[table-mgmt] Error force removing player:`, err);
  }
}

/**
 * Buscar todas as mesas vazias e fazer cleanup
 * Útil para rodar ao iniciar o servidor
 */
export async function cleanupAllEmptyTables(io: Server): Promise<number> {
  try {
    // Buscar todas as mesas
    const tables = await prisma.table.findMany({
      include: { seats: true },
    });

    let cleanedCount = 0;

    for (const table of tables) {
      const hasPlayers = table.seats.some((s: any) => s.state !== "EMPTY" && s.userId !== null);

      if (!hasPlayers && table.status !== "OPEN") {
        await checkAndCleanupEmptyTable(io, table.id);
        cleanedCount++;
      }
    }

    console.log(`[table-mgmt] Cleaned up ${cleanedCount} empty table(s)`);
    return cleanedCount;
  } catch (err) {
    console.error(`[table-mgmt] Error cleaning up all empty tables:`, err);
    return 0;
  }
}

/**
 * Verificar e remover jogadores inativos (sem heartbeat)
 * Chamar via cron job a cada 1-2 minutos
 */
export async function removeInactivePlayers(io: Server, inactivityThresholdMs = 60_000): Promise<number> {
  try {
    // Esta função precisa de um sistema de heartbeat
    // Por enquanto, vamos apenas logar
    console.log(`[table-mgmt] Inactivity check not yet implemented (needs heartbeat system)`);
    return 0;
  } catch (err) {
    console.error(`[table-mgmt] Error removing inactive players:`, err);
    return 0;
  }
}
