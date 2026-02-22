/**
 * Leaderboard routes - adicionar ao index.ts
 */

import Router  from "express";
import { requireAuth } from "./auth";
import { getLeaderboard, getPlayerRank, type LeaderboardMetric, type LeaderboardPeriod } from "./services/leaderboard.service";
import { getPlayerStats, getPlayerDailyStats } from "./services/stats.service";

const router = Router();

/**
 * GET /leaderboard
 * Query params:
 * - metric: "profit" | "winRate" | "handsPlayed" | "biggestWin" (default: "profit")
 * - period: "all" | "30d" | "7d" | "today" (default: "all")
 * - limit: number (default: 100, max: 500)
 */
router.get("/leaderboard", async (req: any, res: any) => {
  try {
    const metric = (req.query.metric as LeaderboardMetric) || "profit";
    const period = (req.query.period as LeaderboardPeriod) || "all";
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    const leaderboard = await getLeaderboard(metric, period, limit);

    // Se usuário está autenticado, incluir seu rank
    let myRank: number | null = null;
    const token = req.headers.authorization?.replace("Bearer ", "");
    
    if (token) {
      try {
        const { decodeJwt } = await import("./auth");
        const decoded = decodeJwt(token);
        
        if (decoded?.userId) {
          myRank = await getPlayerRank(decoded.userId, metric, period);
        }
      } catch {
        // Token inválido, ignorar
      }
    }

    res.json({
      leaderboard,
      myRank,
      totalPlayers: leaderboard.length,
      metric,
      period,
    });
  } catch (err: any) {
    console.error("[leaderboard] Error:", err);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

/**
 * GET /stats/me
 * Retorna stats do usuário logado
 */
router.get("/stats/me", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.userId;

    const stats = await getPlayerStats(userId);
    
    if (!stats) {
      return res.status(404).json({ error: "Stats not found" });
    }

    // Buscar rankings
    const [profitRank, winRateRank, handsPlayedRank, biggestWinRank] = await Promise.all([
      getPlayerRank(userId, "profit"),
      getPlayerRank(userId, "winRate"),
      getPlayerRank(userId, "handsPlayed"),
      getPlayerRank(userId, "biggestWin"),
    ]);

    res.json({
      stats,
      rankings: {
        profit: profitRank,
        winRate: winRateRank,
        handsPlayed: handsPlayedRank,
        biggestWin: biggestWinRank,
      },
    });
  } catch (err: any) {
    console.error("[stats] Error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

/**
 * GET /stats/:userId
 * Retorna stats de um usuário específico
 */
router.get("/stats/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const stats = await getPlayerStats(userId);
    
    if (!stats) {
      return res.status(404).json({ error: "Stats not found" });
    }

    // Buscar rankings (opcional, pode ser pesado)
    const [profitRank, winRateRank, handsPlayedRank] = await Promise.all([
      getPlayerRank(userId, "profit"),
      getPlayerRank(userId, "winRate"),
      getPlayerRank(userId, "handsPlayed"),
    ]);

    res.json({
      stats,
      rankings: {
        profit: profitRank,
        winRate: winRateRank,
        handsPlayed: handsPlayedRank,
      },
    });
  } catch (err: any) {
    console.error("[stats] Error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

/**
 * GET /stats/me/daily
 * Retorna stats diárias do usuário logado
 * Query params:
 * - days: number (default: 30, max: 365)
 */
router.get("/stats/me/daily", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const days = Math.min(Number(req.query.days) || 30, 365);

    const dailyStats = await getPlayerDailyStats(userId, days);

    res.json({ dailyStats });
  } catch (err: any) {
    console.error("[stats] Error:", err);
    res.status(500).json({ error: "Failed to fetch daily stats" });
  }
});

export default router;

// Adicionar ao index.ts:
// import leaderboardRoutes from "./leaderboard.routes";
// app.use(leaderboardRoutes);
