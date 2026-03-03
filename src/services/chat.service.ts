/**
 * Chat service - mensagens na mesa com Redis (cache) + PostgreSQL (persistência)
 */

import { redis } from "../redis";
import { prisma } from "../prisma";

const CHAT_RATE_LIMIT = 10; // mensagens
const CHAT_RATE_WINDOW = 30_000; // 30 segundos
const CHAT_MAX_LENGTH = 500;
const REDIS_CHAT_MAX = 100; // últimas 100 mensagens no Redis
const REDIS_CHAT_TTL = 86400; // 24h

export type ChatMessage = {
  id: string;
  tableId: string;
  userId: string;
  username: string;
  message: string;
  timestamp: number; // unix ms
};

/**
 * Rate limit check para chat
 */
export async function checkChatRateLimit(tableId: string, userId: string): Promise<boolean> {
  const key = `chat_rl:${tableId}:${userId}`;
  const now = Date.now();
  const windowStart = now - CHAT_RATE_WINDOW;

  try {
    // Remove mensagens antigas
    await redis.zremrangebyscore(key, 0, windowStart);
    
    // Conta mensagens na janela
    const count = await redis.zcard(key);
    
    if (count >= CHAT_RATE_LIMIT) {
      return false; // Rate limit exceeded
    }
    
    // Registra nova mensagem
    await redis.zadd(key, now, `${now}-${Math.random()}`);
    await redis.expire(key, Math.ceil(CHAT_RATE_WINDOW / 1000) + 10);
    
    return true;
  } catch (err) {
    console.error("[chat] Rate limit error:", err);
    return true; // Fail open
  }
}

/**
 * Valida mensagem de chat
 */
export function validateChatMessage(message: string): { valid: boolean; error?: string } {
  if (!message || typeof message !== "string") {
    return { valid: false, error: "Mensagem inválida" };
  }

  const trimmed = message.trim();
  
  if (trimmed.length === 0) {
    return { valid: false, error: "Mensagem vazia" };
  }
  
  if (trimmed.length > CHAT_MAX_LENGTH) {
    return { valid: false, error: `Mensagem muito longa (max ${CHAT_MAX_LENGTH} caracteres)` };
  }
  
  return { valid: true };
}

/**
 * Sanitiza mensagem (XSS básico)
 */
export function sanitizeMessage(message: string): string {
  return message
    .trim()
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .slice(0, CHAT_MAX_LENGTH);
}

/**
 * Salva mensagem no Redis + PostgreSQL
 */
export async function saveChatMessage(params: {
  tableId: string;
  userId: string;
  username: string;
  message: string;
}): Promise<ChatMessage> {
  const { tableId, userId, username, message } = params;
  
  const sanitized = sanitizeMessage(message);
  const timestamp = Date.now();
  
  // Salva no PostgreSQL (async, não bloqueia)
  const dbMessage = prisma.chatMessage.create({
    data: {
      tableId,
      userId,
      username,
      message: sanitized,
    },
  }).catch(err => {
    console.error("[chat] PostgreSQL save error:", err);
  });
  
  // Salva no Redis (cache)
  const redisKey = `chat:${tableId}`;
  const chatMsg: ChatMessage = {
    id: `${timestamp}-${userId}`, // ID temporário
    tableId,
    userId,
    username,
    message: sanitized,
    timestamp,
  };
  
  try {
    await redis.lpush(redisKey, JSON.stringify(chatMsg));
    await redis.ltrim(redisKey, 0, REDIS_CHAT_MAX - 1);
    await redis.expire(redisKey, REDIS_CHAT_TTL);
  } catch (err) {
    console.error("[chat] Redis save error:", err);
  }
  
  // Aguarda DB save para ter o ID real
  const saved = await dbMessage;
  if (saved) {
    chatMsg.id = saved.id;
  }
  
  return chatMsg;
}

/**
 * Busca histórico de chat (Redis first, fallback PostgreSQL)
 */
export async function getChatHistory(tableId: string, limit = 50): Promise<ChatMessage[]> {
  const redisKey = `chat:${tableId}`;
  
  try {
    // Tenta Redis primeiro (mais rápido)
    const cached = await redis.lrange(redisKey, 0, limit - 1);
    
    if (cached && cached.length > 0) {
      return cached
        .map(json => {
          try {
            return JSON.parse(json) as ChatMessage;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .reverse(); // Redis retorna do mais novo ao mais antigo
    }
  } catch (err) {
    console.error("[chat] Redis history error:", err);
  }
  
  // Fallback: busca no PostgreSQL
  try {
    const messages = await prisma.chatMessage.findMany({
      where: { tableId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    
    return messages.reverse().map(m => ({
      id: m.id,
      tableId: m.tableId,
      userId: m.userId,
      username: m.username,
      message: m.message,
      timestamp: m.createdAt.getTime(),
    }));
  } catch (err) {
    console.error("[chat] PostgreSQL history error:", err);
    return [];
  }
}

/**
 * Limpa histórico antigo (cron job, executar 1x/dia)
 */
export async function cleanOldChatMessages(daysToKeep = 30): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysToKeep);
  
  try {
    const result = await prisma.chatMessage.deleteMany({
      where: {
        createdAt: { lt: cutoff },
      },
    });
    
    console.log(`[chat] Cleaned ${result.count} old messages (older than ${daysToKeep} days)`);
    return result.count;
  } catch (err) {
    console.error("[chat] Cleanup error:", err);
    return 0;
  }
}
