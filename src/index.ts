import "dotenv/config";
import { validateEnv, logEnvSummary } from "./config/env";

// Validate environment variables FIRST, before any other imports that depend on them.
const env = validateEnv();
logEnvSummary(env);

import express from "express";
import { createLeaderboardRoutes } from "./leaderboard.routes";

import http from "http";
import cors from "cors";
import { buildSocketServer } from "./realtime/socket";
import { prisma } from "./prisma";
import bcrypt from "bcrypt";
import { z } from "zod";
import { signJwt, verifyJwt } from "./auth";
import { ensureWallet } from "./services/wallet.service";
import { RateLimiters } from "./middleware/rate-limit";
import { cleanupAllEmptyTables } from "./services/table-management.service";

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
app.use((req: any, res: any, next: any) => {
  // Preflight request
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

app.get("/health", (_req: express.Request, res: express.Response) => res.json({ ok: true }));

// -----------------
// Auth (MVP simples)
// -----------------
const authBodySchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(6).max(128),
});

app.post("/auth/register", RateLimiters.auth, async (req: express.Request, res: express.Response) => {
  const parsed = authBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  }

  const { username, password } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return res.status(409).json({ error: "USERNAME_TAKEN" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { username, passwordHash },
    select: { id: true, username: true },
  });

  // Cleanup empty tables on boot
  setTimeout(async () => {
    console.log('[boot] Running initial table cleanup...');
    try {
      const count = await cleanupAllEmptyTables(io);
      console.log(`[boot] Cleaned up ${count} empty table(s)`);
    } catch (err) {
      console.error('[boot] Table cleanup failed:', err);
    }
  }, 5000); // 5s after boot


  const wallet = await prisma.wallet.create({
    data: { userId: user.id, balance: 10_000 },
    select: { balance: true },
  });

  const token = signJwt({ userId: user.id, username: user.username });
  return res.json({ token, user, wallet });
});

app.post("/auth/login", RateLimiters.auth, async (req: express.Request, res: express.Response) => {
  const parsed = authBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  }

  const { username, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }

  await ensureWallet(user.id);
  const wallet = await prisma.wallet.findUnique({
    where: { userId: user.id },
    select: { balance: true },
  });

  const token = signJwt({ userId: user.id, username: user.username });
  return res.json({ token, user: { id: user.id, username: user.username }, wallet });
});

async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const header = req.headers.authorization?.toString() ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!token) return res.status(401).json({ error: "UNAUTHORIZED" });
    
    // Check blacklist first
    const { isTokenBlacklisted } = await import("./auth");
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
app.post("/auth/logout", requireAuth, async (req: express.Request, res: express.Response) => {
  const header = req.headers.authorization?.toString() ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (token) {
    const { blacklistToken } = await import("./auth");
    await blacklistToken(token);
  }
  res.json({ ok: true });
});

app.get("/wallet", requireAuth, async (req: express.Request, res: express.Response) => {
  const user = (req as any).user as { userId: string };
  await ensureWallet(user.userId);
  const wallet = await prisma.wallet.findUnique({
    where: { userId: user.userId },
    select: { balance: true },
  });
  return res.json({ wallet });
});

app.get("/tables", async (_req: express.Request, res: express.Response) => {
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
app.post("/tables", requireAuth, RateLimiters.tableCreate, async (req: express.Request, res: express.Response) => {
  const { name, smallBlind, bigBlind, maxPlayers } = req.body;

  // Basic validation
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

const server = http.createServer(app);
const io = buildSocketServer(server);

server.listen(process.env.PORT ?? 3001, () => {
  console.log(`API listening on :${process.env.PORT ?? 3001}`);

  // Recover in-progress hands whose turn timers were lost on restart/crash.
  import('./poker/timer-recovery').then(({ recoverActiveTimers }) => {
    recoverActiveTimers(io).catch((err: unknown) =>
      console.error('[timer-recovery] Boot recovery failed:', err)
    );
  });
});

// --- Graceful shutdown ---
async function shutdown(signal: string) {
  console.log(`[shutdown] Received ${signal}, shutting down gracefully...`);
  server.close(async () => {
    try {
      await prisma.$disconnect();
      console.log('[shutdown] Prisma disconnected.');
    } catch (err) {
      console.error('[shutdown] Error disconnecting Prisma:', err);
    }
    process.exit(0);
  });
  setTimeout(() => { process.exit(1); }, 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));
