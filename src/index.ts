// src/index.ts (ou server.ts)

import "dotenv/config";

import express, { type NextFunction, type Request, type Response } from "express";
import http from "http";
import cors from "cors";
import bcrypt from "bcrypt";
import { z } from "zod";

import { validateEnv, logEnvSummary } from "./config/env";
import { createLeaderboardRoutes } from "./leaderboard.routes";
import { buildSocketServer } from "./realtime/socket";
import { prisma } from "./prisma";
import { signJwt, verifyJwt, isTokenBlacklisted, blacklistToken } from "./auth";
import { ensureWallet } from "./services/wallet.service";
import { RateLimiters } from "./middleware/rate-limit";
import { cleanupAllEmptyTables } from "./services/table-management.service";

// -----------------
// Boot / Env
// -----------------
const env = validateEnv();
logEnvSummary(env);

// -----------------
// App setup
// -----------------
const app = express();

const allowedOrigin = process.env.CORS_ORIGIN ?? "http://localhost:3000";

app.use(
  cors({
    origin: allowedOrigin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Preflight
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

// -----------------
// Auth (MVP simples)
// -----------------
const authBodySchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(6).max(128),
});

app.post("/auth/register", RateLimiters.auth, async (req: Request, res: Response) => {
  const parsed = authBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  }

  const { username, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) return res.status(409).json({ error: "USERNAME_TAKEN" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { username, passwordHash },
    select: { id: true, username: true, role: true },
  });

  const wallet = await prisma.wallet.create({
    data: { userId: user.id, balance: 10_000 },
    select: { balance: true },
  });

  const token = signJwt({ userId: user.id, username: user.username });

  return res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role || "USER" },
    wallet,
  });
});

app.post("/auth/login", RateLimiters.auth, async (req: Request, res: Response) => {
  const parsed = authBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  }

  const { username, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return res.status(401).json({ error: "INVALID_CREDENTIALS" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "INVALID_CREDENTIALS" });

  await ensureWallet(user.id);

  const wallet = await prisma.wallet.findUnique({
    where: { userId: user.id },
    select: { balance: true },
  });

  const token = signJwt({ userId: user.id, username: user.username });

  return res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role || "USER" },
    wallet,
  });
});

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization?.toString() ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!token) return res.status(401).json({ error: "UNAUTHORIZED" });

    if (await isTokenBlacklisted(token)) {
      return res.status(401).json({ error: "TOKEN_REVOKED" });
    }

    const user = verifyJwt(token);
    (req as any).user = user;
    return next();
  } catch {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }
}

// Logout: blacklist the current token
app.post("/auth/logout", requireAuth, async (req: Request, res: Response) => {
  const header = req.headers.authorization?.toString() ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (token) await blacklistToken(token);
  res.json({ ok: true });
});

// -----------------
// Wallet
// -----------------
app.get("/wallet", requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user as { userId: string };
  await ensureWallet(user.userId);

  const wallet = await prisma.wallet.findUnique({
    where: { userId: user.userId },
    select: { balance: true },
  });

  res.json({ balance: wallet?.balance || 0 });
});

// Daily Bonus
app.post("/wallet/daily-bonus", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId as string;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { lastDailyBonus: true },
    });

    if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });

    const now = new Date();
    const lastBonus = user.lastDailyBonus;

    if (lastBonus) {
      const hoursSinceLastBonus = (now.getTime() - lastBonus.getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastBonus < 24) {
        const hoursRemaining = Math.ceil(24 - hoursSinceLastBonus);
        return res.status(400).json({
          error: "DAILY_BONUS_CLAIMED",
          message: `Você já coletou seu bônus diário. Próximo em ${hoursRemaining}h.`,
          hoursRemaining,
        });
      }
    }

    const bonusAmount = 1000;

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { lastDailyBonus: now },
      }),
      prisma.wallet.update({
        where: { userId },
        data: { balance: { increment: bonusAmount } },
      }),
    ]);

    const wallet = await prisma.wallet.findUnique({
      where: { userId },
      select: { balance: true },
    });

    res.json({
      success: true,
      bonus: bonusAmount,
      balance: wallet?.balance || 0,
      nextBonusIn: 24,
    });
  } catch (err: any) {
    console.error("[daily-bonus] Error:", err);
    res.status(500).json({ error: "FAILED_TO_CLAIM_DAILY_BONUS" });
  }
});

// Check if user can claim daily bonus
app.get("/wallet/daily-bonus/status", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId as string;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { lastDailyBonus: true },
    });

    if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });

    const now = new Date();
    const lastBonus = user.lastDailyBonus;

    let canClaim = true;
    let hoursRemaining = 0;

    if (lastBonus) {
      const hoursSinceLastBonus = (now.getTime() - lastBonus.getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastBonus < 24) {
        canClaim = false;
        hoursRemaining = Math.ceil(24 - hoursSinceLastBonus);
      }
    }

    res.json({
      canClaim,
      hoursRemaining,
      bonusAmount: 1000,
    });
  } catch (err: any) {
    console.error("[daily-bonus-status] Error:", err);
    res.status(500).json({ error: "FAILED_TO_CHECK_BONUS_STATUS" });
  }
});

// Admin: Add coins to user
app.post("/wallet/add-coins", requireAuth, async (req: Request, res: Response) => {
  try {
    const adminUserId = (req as any).user.userId as string;
    const { targetUserId, amount } = req.body as { targetUserId?: string; amount?: number };

    const adminUser = await prisma.user.findUnique({
      where: { id: adminUserId },
      select: { role: true },
    });

    if (adminUser?.role !== "ADMIN") {
      return res.status(403).json({ error: "FORBIDDEN", message: "Only admins can add coins" });
    }

    if (!targetUserId || typeof targetUserId !== "string") {
      return res.status(400).json({ error: "INVALID_TARGET_USER" });
    }

    if (typeof amount !== "number" || amount <= 0 || amount > 1_000_000) {
      return res.status(400).json({ error: "INVALID_AMOUNT" });
    }

    await prisma.wallet.update({
      where: { userId: targetUserId },
      data: { balance: { increment: amount } },
    });

    const wallet = await prisma.wallet.findUnique({
      where: { userId: targetUserId },
      select: { balance: true },
    });

    res.json({ success: true, amount, newBalance: wallet?.balance || 0 });
  } catch (err: any) {
    console.error("[add-coins] Error:", err);
    res.status(500).json({ error: "FAILED_TO_ADD_COINS" });
  }
});

// Recharge (fictício)
app.post("/wallet/recharge", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId as string;
    const { amount } = req.body as { amount?: number };

    if (typeof amount !== "number" || amount <= 0 || amount > 100_000) {
      return res.status(400).json({
        error: "INVALID_AMOUNT",
        message: "Amount must be between 1 and 100,000",
      });
    }

    // Cooldown: 1 min (usando lastRecharge)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { lastRecharge: true },
    });

    if (user?.lastRecharge) {
      const now = new Date();
      const secondsSinceRecharge = (now.getTime() - user.lastRecharge.getTime()) / 1000;

      if (secondsSinceRecharge < 60) {
        const remainingSeconds = Math.ceil(60 - secondsSinceUpdate);
        return res.status(429).json({
          error: "COOLDOWN",
          message: `Please wait ${remainingSeconds}s before recharging again`,
          remainingSeconds,
        });
      }
    }

    await prisma.$transaction([
      prisma.wallet.update({
        where: { userId },
        data: { balance: { increment: amount } },
      }),
      // marca “última recarga” via updatedAt (se seu schema bloquear, crie um campo específico)
      prisma.user.update({
        where: { id: userId },
        data: { lastRecharge: new Date() },
      }),
    ]);

    const wallet = await prisma.wallet.findUnique({
      where: { userId },
      select: { balance: true },
    });

    res.json({ success: true, amount, newBalance: wallet?.balance || 0 });
  } catch (err: any) {
    console.error("[recharge] Error:", err);
    res.status(500).json({ error: "FAILED_TO_RECHARGE_BALANCE" });
  }
});

// -----------------
// Profile
// -----------------
app.get("/profile/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId as string;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        role: true,
        createdAt: true,
        lastDailyBonus: true,
      },
    });

    if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });

    const wallet = await prisma.wallet.findUnique({
      where: { userId },
      select: { balance: true },
    });

    const stats = await prisma.playerStats.findUnique({
      where: { userId },
      select: {
        handsPlayed: true,
        handsWon: true,
        totalProfit: true,
        biggestWin: true,
        biggestLoss: true,
      },
    });

    res.json({
      user: {
        ...user,
        balance: wallet?.balance || 0,
        stats: stats || {
          handsPlayed: 0,
          handsWon: 0,
          totalProfit: 0,
          biggestWin: 0,
          biggestLoss: 0,
        },
      },
    });
  } catch (err: any) {
    console.error("[profile] Error:", err);
    res.status(500).json({ error: "FAILED_TO_FETCH_PROFILE" });
  }
});

// -----------------
// Tables
// -----------------
app.get("/tables", async (_req: Request, res: Response) => {
  const tables = await prisma.table.findMany({
    where: { status: { in: ["OPEN", "RUNNING"] } },
    orderBy: { createdAt: "desc" },
    include: { seats: true },
  });

  return res.json(
    tables.map((t: any) => ({
      id: t.id,
      name: t.name,
      smallBlind: t.smallBlind,
      bigBlind: t.bigBlind,
      maxPlayers: t.maxPlayers,
      status: t.status,
      players: t.seats.filter((s: any) => s.userId).length,
    }))
  );
});

// Create table (authenticated users only, rate limited)
// In production, this should be further restricted to admin users only.
app.post("/tables", requireAuth, RateLimiters.tableCreate, async (req: Request, res: Response) => {
  const userId = (req as any).user.userId as string;
  const { name, smallBlind, bigBlind, maxPlayers } = req.body as {
    name?: string;
    smallBlind?: number;
    bigBlind?: number;
    maxPlayers?: number;
  };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (user?.role !== "ADMIN") {
    return res.status(403).json({
      error: "FORBIDDEN",
      message: "Only admins can create tables",
    });
  }

  if (!name || typeof smallBlind !== "number" || typeof bigBlind !== "number" || typeof maxPlayers !== "number") {
    return res.status(400).json({ error: "INVALID_BODY", message: "Missing or invalid fields." });
  }

  if (maxPlayers < 2 || maxPlayers > 10) {
    return res.status(400).json({ error: "INVALID_MAX_PLAYERS", message: "maxPlayers must be between 2 and 10." });
  }

  if (smallBlind <= 0 || bigBlind <= 0 || bigBlind <= smallBlind) {
    return res.status(400).json({ error: "INVALID_BLINDS", message: "Blinds must be positive and BB > SB." });
  }

  const table = await prisma.table.create({
    data: {
      name,
      smallBlind,
      bigBlind,
      maxPlayers,
      seats: {
        create: Array.from({ length: maxPlayers }).map((_, i) => ({
          seatNo: i + 1,
          state: "EMPTY",
          stack: 0,
        })),
      },
    },
    include: { seats: true },
  });

  res.json(table);
});

// Leaderboard & Stats routes
const leaderboardRouter = createLeaderboardRoutes(requireAuth);
app.use(leaderboardRouter);

// -----------------
// Hand History
// -----------------
app.get("/history/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId as string;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;

    const history = await prisma.$queryRaw`
      SELECT * FROM "HandHistory"
      WHERE players::jsonb @> ${`[{"userId": "${userId}"}]`}::jsonb
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    res.json({ history });
  } catch (err: any) {
    console.error("[hand-history] Error:", err);
    res.status(500).json({ error: "FAILED_TO_FETCH_HAND_HISTORY" });
  }
});

app.get("/hands/:handId", requireAuth, async (req: Request, res: Response) => {
  try {
    const { handId } = req.params;

    const hand = await prisma.handHistory.findUnique({
      where: { handId },
    });

    if (!hand) return res.status(404).json({ error: "HAND_NOT_FOUND" });

    res.json({ hand });
  } catch (err: any) {
    console.error("[hand-details] Error:", err);
    res.status(500).json({ error: "FAILED_TO_FETCH_HAND_DETAILS" });
  }
});

app.get("/tables/:tableId/history", requireAuth, async (req: Request, res: Response) => {
  try {
    const { tableId } = req.params;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;

    const { getTableHandHistory } = await import("./services/hand-history.service");
    const history = await getTableHandHistory({ tableId, limit, offset });

    res.json({ history });
  } catch (err: any) {
    console.error("[table-history] Error:", err);
    res.status(500).json({ error: "FAILED_TO_FETCH_TABLE_HISTORY" });
  }
});

// -----------------
// Server + Socket
// -----------------
const server = http.createServer(app);
const io = buildSocketServer(server);

server.listen(process.env.PORT ?? 3001, () => {
  console.log(`API listening on :${process.env.PORT ?? 3001}`);

  // Boot: cleanup empty tables
  setTimeout(async () => {
    console.log("[boot] Running initial table cleanup...");
    try {
      const count = await cleanupAllEmptyTables(io);
      console.log(`[boot] Cleaned up ${count} empty table(s)`);
    } catch (err) {
      console.error("[boot] Table cleanup failed:", err);
    }
  }, 1500);

  // Recover in-progress hands whose turn timers were lost on restart/crash.
  import("./poker/timer-recovery").then(({ recoverActiveTimers }) => {
    recoverActiveTimers(io).catch((err: unknown) => console.error("[timer-recovery] Boot recovery failed:", err));
  });
});

// --- Graceful shutdown ---
async function shutdown(signal: string) {
  console.log(`[shutdown] Received ${signal}, shutting down gracefully...`);
  server.close(async () => {
    try {
      await prisma.$disconnect();
      console.log("[shutdown] Prisma disconnected.");
    } catch (err) {
      console.error("[shutdown] Error disconnecting Prisma:", err);
    }
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));