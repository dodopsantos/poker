/**
 * Rate limiting for HTTP routes and Socket.IO events.
 * Uses Redis for distributed rate limiting (multi-instance safe).
 */

import { redis } from "../redis";
import type { Request, Response, NextFunction } from "express";
import type { Socket } from "socket.io";

/**
 * Generic Redis-based rate limiter.
 * Returns true if the request is allowed, false if rate limit exceeded.
 */
async function checkRateLimit(params: {
  key: string;
  maxRequests: number;
  windowMs: number;
}): Promise<{ allowed: boolean; retryAfter?: number }> {
  const { key, maxRequests, windowMs } = params;
  const now = Date.now();
  const windowStart = now - windowMs;

  try {
    // Use a sorted set where score = timestamp
    // Remove old entries outside the current window
    await redis.zremrangebyscore(key, 0, windowStart);

    // Count requests in the current window
    const count = await redis.zcard(key);

    if (count >= maxRequests) {
      // Rate limit exceeded. Calculate retry-after.
      const oldest = await redis.zrange(key, 0, 0, "WITHSCORES");
      const oldestTimestamp = oldest.length >= 2 ? Number(oldest[1]) : now;
      const retryAfter = Math.ceil((oldestTimestamp + windowMs - now) / 1000);
      return { allowed: false, retryAfter: Math.max(1, retryAfter) };
    }

    // Allow the request and record it
    await redis.zadd(key, now, `${now}-${Math.random()}`);
    // Set expiry on the key (cleanup)
    await redis.expire(key, Math.ceil(windowMs / 1000) + 10);

    return { allowed: true };
  } catch (err) {
    // On Redis failure, allow the request (fail open) but log the error
    console.error("[rate-limit] Redis error, allowing request:", err);
    return { allowed: true };
  }
}

/**
 * HTTP rate limiter middleware factory.
 * Example: app.use("/auth/login", createHttpRateLimiter({ maxRequests: 5, windowMs: 60_000 }));
 */
export function createHttpRateLimiter(params: {
  maxRequests: number;
  windowMs: number;
  keyPrefix?: string;
}) {
  const { maxRequests, windowMs, keyPrefix = "http_rl" } = params;

  return async (req: Request, res: Response, next: NextFunction) => {
    // Use IP as identifier (or userId if authenticated)
    const identifier = (req as any).user?.userId ?? req.ip ?? "unknown";
    const key = `${keyPrefix}:${identifier}`;

    const result = await checkRateLimit({ key, maxRequests, windowMs });

    if (!result.allowed) {
      res.setHeader("Retry-After", result.retryAfter ?? 60);
      return res.status(429).json({
        error: "RATE_LIMIT_EXCEEDED",
        message: `Too many requests. Try again in ${result.retryAfter}s.`,
        retryAfter: result.retryAfter,
      });
    }

    next();
  };
}

/**
 * Socket.IO rate limiter.
 * Call this at the start of each event handler that needs rate limiting.
 * Example:
 *   socket.on("table:action", async (data) => {
 *     if (!(await allowSocketEvent(socket, "table:action", { maxRequests: 10, windowMs: 10_000 }))) {
 *       socket.emit("table:event", { type: "ERROR", code: "RATE_LIMIT", message: "Too many actions." });
 *       return;
 *     }
 *     // ... proceed with action
 *   });
 */
export async function allowSocketEvent(
  socket: Socket,
  eventName: string,
  params: { maxRequests: number; windowMs: number }
): Promise<boolean> {
  const user = (socket.data as any).user as { userId: string } | undefined;
  const identifier = user?.userId ?? socket.id;
  const key = `socket_rl:${eventName}:${identifier}`;

  const result = await checkRateLimit({ key, maxRequests: params.maxRequests, windowMs: params.windowMs });
  return result.allowed;
}

/**
 * Predefined rate limiters for common routes.
 */
export const RateLimiters = {
  // Auth routes: strict (prevent brute force)
  auth: createHttpRateLimiter({ maxRequests: 5, windowMs: 60_000, keyPrefix: "auth" }),
  // General API: lenient
  api: createHttpRateLimiter({ maxRequests: 100, windowMs: 60_000, keyPrefix: "api" }),
  // Table creation: very strict (admin only in production, but rate limit anyway)
  tableCreate: createHttpRateLimiter({ maxRequests: 10, windowMs: 60_000, keyPrefix: "table_create" }),
};

/**
 * Predefined Socket.IO rate limit configs.
 */
export const SocketRateLimits = {
  // Player actions (fold, call, raise): lenient (players need to act fast)
  action: { maxRequests: 20, windowMs: 10_000 },
  // Sit/leave: moderate (shouldn't happen rapidly)
  sitLeave: { maxRequests: 5, windowMs: 30_000 },
  // Join: lenient (reconnections)
  join: { maxRequests: 10, windowMs: 30_000 },
  // Rebuy: moderate
  rebuy: { maxRequests: 5, windowMs: 60_000 },
};
