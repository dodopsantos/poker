/**
 * Leaderboard service - rankings e consultas
 */

import { prisma } from "../prisma";


type StatsEntry = {
  userId: string;
  username: string;
  handsPlayed: number;
  handsWon: number;
  winRate: number;
  totalProfit: number;
  biggestWin: number;
};

type OrderByField = { [key: string]: "asc" | "desc" };

export type LeaderboardMetric = "profit" | "winRate" | "handsPlayed" | "biggestWin";
export type LeaderboardPeriod = "all" | "30d" | "7d" | "today";

type LeaderboardEntry = {
  rank: number;
  userId: string;
  username: string;
  value: number;
  handsPlayed: number;
  winRate: number;
  totalProfit: number;
};

/**
 * Buscar leaderboard global
 */
export async function getLeaderboard(
  metric: LeaderboardMetric = "profit",
  period: LeaderboardPeriod = "all",
  limit = 100
): Promise<LeaderboardEntry[]> {
  if (period !== "all") {
    // Use daily stats para períodos específicos
    return getLeaderboardFromDailyStats(metric, period, limit);
  }

  // All-time stats
  const MIN_HANDS = metric === "winRate" ? 100 : 1; // Win rate requer min 100 mãos

  let orderBy: OrderByField = {};
  switch (metric) {
    case "profit":
      orderBy = { totalProfit: "desc" };
      break;
    case "handsPlayed":
      orderBy = { handsPlayed: "desc" };
      break;
    case "biggestWin":
      orderBy = { biggestWin: "desc" };
      break;
    case "winRate":
      // Win rate calculado no app layer
      orderBy = { handsWon: "desc" }; // Proxy temporário
      break;
  }

  const stats = await prisma.playerStats.findMany({
    where: {
      handsPlayed: { gte: MIN_HANDS },
    },
    include: {
      user: {
        select: { id: true, username: true },
      },
    },
    orderBy,
    take: limit * 2, // Pegar mais para filtrar win rate
  });

  let entries = stats.map((s) => ({
    userId: s.userId,
    username: s.user.username,
    handsPlayed: s.handsPlayed,
    handsWon: s.handsWon,
    winRate: s.handsPlayed > 0 ? s.handsWon / s.handsPlayed : 0,
    totalProfit: s.totalProfit,
    biggestWin: s.biggestWin,
  }));

  // Sort por win rate se necessário
  if (metric === "winRate") {
    entries = entries
      .filter((e) => e.handsPlayed >= MIN_HANDS)
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, limit);
  } else {
    entries = entries.slice(0, limit);
  }

  // Calcular value baseado no metric
  return entries.map((e, idx) => ({
    rank: idx + 1,
    userId: e.userId,
    username: e.username,
    value: getMetricValue(e, metric),
    handsPlayed: e.handsPlayed,
    winRate: Math.round(e.winRate * 100) / 100,
    totalProfit: e.totalProfit,
  }));
}

/**
 * Buscar leaderboard de período específico (daily stats)
 */
async function getLeaderboardFromDailyStats(
  metric: LeaderboardMetric,
  period: LeaderboardPeriod,
  limit: number
): Promise<LeaderboardEntry[]> {
  const cutoff = getPeriodCutoff(period);

  // Agregar daily stats por usuário
  const aggregated = await prisma.dailyStats.groupBy({
    by: ["userId"],
    where: {
      date: { gte: cutoff },
    },
    _sum: {
      handsPlayed: true,
      handsWon: true,
      profit: true,
    },
  });

  // Buscar usernames
  const userIds = aggregated.map((a) => a.userId);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, username: true },
  });

  const userMap = new Map(users.map((u) => [u.id, u.username]));

  // Montar entries
  let entries = aggregated.map((a) => {
    const handsPlayed = a._sum.handsPlayed ?? 0;
    const handsWon = a._sum.handsWon ?? 0;
    const profit = a._sum.profit ?? 0;
    const winRate = handsPlayed > 0 ? handsWon / handsPlayed : 0;

    return {
      userId: a.userId,
      username: userMap.get(a.userId) ?? "Unknown",
      handsPlayed,
      handsWon,
      winRate,
      totalProfit: profit,
      biggestWin: 0, // Daily stats não tem biggest win individual
    };
  });

  // Filtrar e ordenar
  const MIN_HANDS = metric === "winRate" ? 50 : 1;
  entries = entries.filter((e) => e.handsPlayed >= MIN_HANDS);

  switch (metric) {
    case "profit":
      entries.sort((a, b) => b.totalProfit - a.totalProfit);
      break;
    case "winRate":
      entries.sort((a, b) => b.winRate - a.winRate);
      break;
    case "handsPlayed":
      entries.sort((a, b) => b.handsPlayed - a.handsPlayed);
      break;
    case "biggestWin":
      // Not available in daily stats, fall back to profit
      entries.sort((a, b) => b.totalProfit - a.totalProfit);
      break;
  }

  entries = entries.slice(0, limit);

  return entries.map((e, idx) => ({
    rank: idx + 1,
    userId: e.userId,
    username: e.username,
    value: getMetricValue(e, metric),
    handsPlayed: e.handsPlayed,
    winRate: Math.round(e.winRate * 100) / 100,
    totalProfit: e.totalProfit,
  }));
}

/**
 * Buscar ranking do usuário em um metric específico
 */
export async function getPlayerRank(
  userId: string,
  metric: LeaderboardMetric = "profit",
  period: LeaderboardPeriod = "all"
): Promise<number | null> {
  if (period !== "all") {
    return getPlayerRankFromDailyStats(userId, metric, period);
  }

  const stats = await prisma.playerStats.findUnique({
    where: { userId },
  });

  if (!stats || stats.handsPlayed === 0) {
    return null;
  }

  let condition: Record<string, any> = {};
  const MIN_HANDS = metric === "winRate" ? 100 : 1;

  switch (metric) {
    case "profit":
      condition = { totalProfit: { gt: stats.totalProfit }, handsPlayed: { gte: MIN_HANDS } };
      break;
    case "handsPlayed":
      condition = { handsPlayed: { gt: stats.handsPlayed } };
      break;
    case "biggestWin":
      condition = { biggestWin: { gt: stats.biggestWin }, handsPlayed: { gte: MIN_HANDS } };
      break;
    case "winRate":
      // Calcular rank manualmente (complexo no SQL)
      const allStats = await prisma.playerStats.findMany({
        where: { handsPlayed: { gte: MIN_HANDS } },
        select: { userId: true, handsPlayed: true, handsWon: true },
      });

      const myWinRate = stats.handsPlayed > 0 ? stats.handsWon / stats.handsPlayed : 0;
      const betterCount = allStats.filter((s) => {
        const wr = s.handsPlayed > 0 ? s.handsWon / s.handsPlayed : 0;
        return wr > myWinRate;
      }).length;

      return betterCount + 1;
  }

  const betterCount = await prisma.playerStats.count({
    where: condition,
  });

  return betterCount + 1;
}

/**
 * Buscar rank do player em período específico
 */
async function getPlayerRankFromDailyStats(
  userId: string,
  metric: LeaderboardMetric,
  period: LeaderboardPeriod
): Promise<number | null> {
  const cutoff = getPeriodCutoff(period);

  const myStats = await prisma.dailyStats.aggregate({
    where: {
      userId,
      date: { gte: cutoff },
    },
    _sum: {
      handsPlayed: true,
      handsWon: true,
      profit: true,
    },
  });

  if (!myStats._sum.handsPlayed || myStats._sum.handsPlayed === 0) {
    return null;
  }

  const myValue =
    metric === "profit"
      ? myStats._sum.profit ?? 0
      : metric === "handsPlayed"
        ? myStats._sum.handsPlayed ?? 0
        : (myStats._sum.handsWon ?? 0) / (myStats._sum.handsPlayed ?? 1);

  // Contar quantos players têm valor melhor
  // Simplificado: buscar todos e contar (não otimizado, mas funciona para MVP)
  const allPlayers = await prisma.dailyStats.groupBy({
    by: ["userId"],
    where: { date: { gte: cutoff } },
    _sum: {
      handsPlayed: true,
      handsWon: true,
      profit: true,
    },
  });

  const betterCount = allPlayers.filter((p) => {
    const value =
      metric === "profit"
        ? (p._sum.profit ?? 0)
        : metric === "handsPlayed"
          ? (p._sum.handsPlayed ?? 0)
          : ((p._sum.handsWon ?? 0) / (p._sum.handsPlayed ?? 1));

    return value > myValue;
  }).length;

  return betterCount + 1;
}

/**
 * Helpers
 */
function getMetricValue(entry: StatsEntry, metric: LeaderboardMetric): number {
  switch (metric) {
    case "profit":
      return entry.totalProfit;
    case "winRate":
      return Math.round(entry.winRate * 10000) / 100; // % com 2 decimais
    case "handsPlayed":
      return entry.handsPlayed;
    case "biggestWin":
      return entry.biggestWin;
  }
}

function getPeriodCutoff(period: LeaderboardPeriod): Date {
  const now = new Date();
  const cutoff = new Date(now);

  switch (period) {
    case "today":
      cutoff.setHours(0, 0, 0, 0);
      break;
    case "7d":
      cutoff.setDate(cutoff.getDate() - 7);
      break;
    case "30d":
      cutoff.setDate(cutoff.getDate() - 30);
      break;
    default:
      cutoff.setFullYear(2000); // All-time
  }

  return cutoff;
}
