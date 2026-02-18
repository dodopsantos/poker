import jwt from "jsonwebtoken";
import { redis } from "./redis";

export type JwtUser = { userId: string; username: string };

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_EXPIRES_IN = "7d"; // Medium-lived: 7 days

export function signJwt(payload: JwtUser) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyJwt(token: string): JwtUser {
    return jwt.verify(token, JWT_SECRET) as JwtUser;
}

/**
 * Blacklist a token (e.g., on logout or security breach).
 * The token will be rejected even if it hasn't expired yet.
 */
export async function blacklistToken(token: string): Promise<void> {
  try {
    const decoded = jwt.decode(token) as { exp?: number };
    if (!decoded?.exp) return;

    // Store in Redis with TTL = remaining time until token expires
    const ttl = Math.max(0, decoded.exp - Math.floor(Date.now() / 1000));
    if (ttl > 0) {
      await redis.set(`blacklist:${token}`, "1", "EX", ttl);
    }
  } catch {
    // If token is invalid, ignore
  }
}

/**
 * Check if a token is blacklisted.
 * Call this in requireAuth middleware before accepting the token.
 */
export async function isTokenBlacklisted(token: string): Promise<boolean> {
  try {
    const exists = await redis.exists(`blacklist:${token}`);
    return exists === 1;
  } catch {
    // On Redis failure, allow the token (fail open for availability)
    return false;
  }
}
