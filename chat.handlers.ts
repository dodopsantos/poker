/**
 * Chat handlers - adicionar ao table.gateway.ts
 */

import { checkChatRateLimit, validateChatMessage, saveChatMessage, getChatHistory } from "../services/chat.service";
import type { Server, Socket } from "socket.io";

/**
 * Registrar handlers de chat (chamar dentro de registerTableGateway)
 */
export function registerChatHandlers(io: Server, socket: Socket) {
  const user = (socket.data as any).user as { userId: string; username: string };

  // Enviar mensagem
  socket.on("table:chat:message", async ({ tableId, message }: { tableId: string; message: string }) => {
    try {
      // Validação
      const validation = validateChatMessage(message);
      if (!validation.valid) {
        socket.emit("table:chat:error", { error: validation.error });
        return;
      }

      // Rate limiting
      const allowed = await checkChatRateLimit(tableId, user.userId);
      if (!allowed) {
        socket.emit("table:chat:error", { error: "Você está enviando mensagens muito rápido. Aguarde um momento." });
        return;
      }

      // Salvar mensagem
      const chatMsg = await saveChatMessage({
        tableId,
        userId: user.userId,
        username: user.username,
        message,
      });

      // Broadcast para todos na mesa
      io.to(`table:${tableId}`).emit("table:chat:message", chatMsg);
    } catch (err: any) {
      console.error("[chat] Send message error:", err);
      socket.emit("table:chat:error", { error: "Erro ao enviar mensagem" });
    }
  });

  // Buscar histórico
  socket.on("table:chat:history", async ({ tableId, limit }: { tableId: string; limit?: number }) => {
    try {
      const messages = await getChatHistory(tableId, limit ?? 50);
      socket.emit("table:chat:history", { messages });
    } catch (err: any) {
      console.error("[chat] Get history error:", err);
      socket.emit("table:chat:error", { error: "Erro ao carregar histórico" });
    }
  });
}

// Exemplo de integração no table.gateway.ts:
/*
export function registerTableGateway(io: Server, socket: Socket) {
  const user = (socket.data as any).user as { userId: string; username: string };

  // ... handlers existentes (table:join, table:sit, etc) ...

  // Chat handlers
  registerChatHandlers(io, socket);
}
*/
