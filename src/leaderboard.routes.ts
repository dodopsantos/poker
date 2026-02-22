/**
 * Leaderboard routes - factory function
 */

import express, { Request, Response, NextFunction } from "express";
import { getLeaderboard, getPlayerRank, type LeaderboardMetric, type LeaderboardPeriod } from "./services/leaderboard.service";
import { getPlayerStats, getPlayerDailyStats } from "./services/stats.service";

// Middleware type
type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

/**
 * Factory function que recebe requireAuth e retorna o router configurado
 */
export function createLeaderboardRoutes(requireAuth: AuthMiddleware) {
  const router = express.Router();

  /**
   * GET /leaderboard
   * Query params:
   * - metric: "profit" | "winRate" | "handsPlayed" | "biggestWin" (default: "profit")
   * - period: "all" | "30d" | "7d" | "today" (default: "all")
   * - limit: number (default: 100, max: 500)
   */
  router.get("/leaderboard", async (req: Request, res: Response) => {
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
          const { verifyJwt } = await import("./auth");
          const decoded = verifyJwt(token);
          
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
  router.get("/stats/me", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.userId;

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
  router.get("/stats/:userId", async (req: Request, res: Response) => {
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
  router.get("/stats/me/daily", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.userId;
      const days = Math.min(Number(req.query.days) || 30, 365);

      const dailyStats = await getPlayerDailyStats(userId, days);

      res.json({ dailyStats });
    } catch (err: any) {
      console.error("[stats] Error:", err);
      res.status(500).json({ error: "Failed to fetch daily stats" });
    }
  });

  return router;
}

export default createLeaderboardRoutes;
