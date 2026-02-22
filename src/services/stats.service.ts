/**
 * Player stats service - atualização e consulta de estatísticas
 */

import { prisma } from "../prisma";

export type StatsUpdate = {
  handsPlayed?: number;
  handsWon?: number;
  profit?: number;
  biggestWin?: number;
  biggestLoss?: number;
  buyins?: number;
  cashouts?: number;
};

/**
 * Garante que PlayerStats existe para o usuário
 */
export async function ensurePlayerStats(userId: string): Promise<void> {
  const existing = await prisma.playerStats.findUnique({
    where: { userId },
  });

  if (!existing) {
    await prisma.playerStats.create({
      data: { userId },
    });
  }
}

/**
 * Atualiza stats do jogador (incremental)
 */
export async function updatePlayerStats(userId: string, update: StatsUpdate): Promise<void> {
  await ensurePlayerStats(userId);

  const data: Record<string, any> = {
    updatedAt: new Date(),
  };

  if (update.handsPlayed) {
    data.handsPlayed = { increment: update.handsPlayed };
    data.lastHandAt = new Date();
  }

  if (update.handsWon) {
    data.handsWon = { increment: update.handsWon };
  }

  if (update.profit) {
    data.totalProfit = { increment: update.profit };
  }

  if (update.buyins) {
    data.totalBuyins = { increment: update.buyins };
  }

  if (update.cashouts) {
    data.totalCashouts = { increment: update.cashouts };
  }

  // Biggest win/loss - comparação manual
  if (update.biggestWin !== undefined || update.biggestLoss !== undefined) {
    const current = await prisma.playerStats.findUnique({
      where: { userId },
      select: { biggestWin: true, biggestLoss: true },
    });

    if (current) {
      if (update.biggestWin !== undefined && update.biggestWin > current.biggestWin) {
        data.biggestWin = update.biggestWin;
      }

      if (update.biggestLoss !== undefined && update.biggestLoss < current.biggestLoss) {
        data.biggestLoss = update.biggestLoss;
      }
    }
  }

  await prisma.playerStats.update({
    where: { userId },
    data,
  });
}

/**
 * Atualiza stats diárias
 */
export async function updateDailyStats(userId: string, date: Date, update: StatsUpdate): Promise<void> {
  const dateOnly = new Date(date.toISOString().split("T")[0]);

  // Upsert
  const existing = await prisma.dailyStats.findUnique({
    where: {
      userId_date: { userId, date: dateOnly },
    },
  });

  if (existing) {
    // Update incremental
    await prisma.dailyStats.update({
      where: { id: existing.id },
      data: {
        handsPlayed: { increment: update.handsPlayed ?? 0 },
        handsWon: { increment: update.handsWon ?? 0 },
        profit: { increment: update.profit ?? 0 },
      },
    });
  } else {
    // Create
    await prisma.dailyStats.create({
      data: {
        userId,
        date: dateOnly,
        handsPlayed: update.handsPlayed ?? 0,
        handsWon: update.handsWon ?? 0,
        profit: update.profit ?? 0,
      },
    });
  }
}

/**
 * Registrar fim de mão nas stats
 */
export async function recordHandResult(params: {
  userId: string;
  isWinner: boolean;
  payout: number;
  committed: number;
}): Promise<void> {
  const { userId, isWinner, payout, committed } = params;
  const profit = payout - committed;

  await updatePlayerStats(userId, {
    handsPlayed: 1,
    handsWon: isWinner ? 1 : 0,
    profit,
    biggestWin: profit > 0 ? profit : undefined,
    biggestLoss: profit < 0 ? profit : undefined,
  });

  await updateDailyStats(userId, new Date(), {
    handsPlayed: 1,
    handsWon: isWinner ? 1 : 0,
    profit,
  });
}

/**
 * Buscar stats do jogador
 */
export async function getPlayerStats(userId: string) {
  await ensurePlayerStats(userId);

  const stats = await prisma.playerStats.findUnique({
    where: { userId },
    include: {
      user: {
        select: { id: true, username: true },
      },
    },
  });

  if (!stats) {
    return null;
  }

  const winRate = stats.handsPlayed > 0 ? stats.handsWon / stats.handsPlayed : 0;

  return {
    userId: stats.userId,
    username: stats.user.username,
    handsPlayed: stats.handsPlayed,
    handsWon: stats.handsWon,
    winRate: Math.round(winRate * 100) / 100,
    totalProfit: stats.totalProfit,
    biggestWin: stats.biggestWin,
    biggestLoss: stats.biggestLoss,
    totalBuyins: stats.totalBuyins,
    totalCashouts: stats.totalCashouts,
    lastHandAt: stats.lastHandAt,
  };
}

/**
 * Buscar stats de múltiplos jogadores (batch)
 */
export async function getBatchPlayerStats(userIds: string[]) {
  const stats = await prisma.playerStats.findMany({
    where: { userId: { in: userIds } },
    include: {
      user: {
        select: { id: true, username: true },
      },
    },
  });

  return stats.map((s) => ({
    userId: s.userId,
    username: s.user.username,
    handsPlayed: s.handsPlayed,
    handsWon: s.handsWon,
    winRate: s.handsPlayed > 0 ? Math.round((s.handsWon / s.handsPlayed) * 100) / 100 : 0,
    totalProfit: s.totalProfit,
    biggestWin: s.biggestWin,
    biggestLoss: s.biggestLoss,
  }));
}

/**
 * Buscar daily stats do jogador (últimos N dias)
 */
export async function getPlayerDailyStats(userId: string, days = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const stats = await prisma.dailyStats.findMany({
    where: {
      userId,
      date: { gte: cutoff },
    },
    orderBy: { date: "asc" },
  });

  return stats.map((s) => ({
    date: s.date,
    handsPlayed: s.handsPlayed,
    handsWon: s.handsWon,
    profit: s.profit,
    winRate: s.handsPlayed > 0 ? Math.round((s.handsWon / s.handsPlayed) * 100) / 100 : 0,
  }));
}
