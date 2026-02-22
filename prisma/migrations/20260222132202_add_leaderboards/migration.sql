-- CreateTable
CREATE TABLE "PlayerStats" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "handsPlayed" INTEGER NOT NULL DEFAULT 0,
    "handsWon" INTEGER NOT NULL DEFAULT 0,
    "totalProfit" INTEGER NOT NULL DEFAULT 0,
    "biggestWin" INTEGER NOT NULL DEFAULT 0,
    "biggestLoss" INTEGER NOT NULL DEFAULT 0,
    "totalBuyins" INTEGER NOT NULL DEFAULT 0,
    "totalCashouts" INTEGER NOT NULL DEFAULT 0,
    "vpip" DOUBLE PRECISION DEFAULT 0,
    "pfr" DOUBLE PRECISION DEFAULT 0,
    "aggressionFactor" DOUBLE PRECISION DEFAULT 0,
    "lastHandAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyStats" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "handsPlayed" INTEGER NOT NULL DEFAULT 0,
    "handsWon" INTEGER NOT NULL DEFAULT 0,
    "profit" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyStats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlayerStats_userId_key" ON "PlayerStats"("userId");

-- CreateIndex
CREATE INDEX "PlayerStats_totalProfit_idx" ON "PlayerStats"("totalProfit");

-- CreateIndex
CREATE INDEX "PlayerStats_handsWon_idx" ON "PlayerStats"("handsWon");

-- CreateIndex
CREATE INDEX "PlayerStats_handsPlayed_idx" ON "PlayerStats"("handsPlayed");

-- CreateIndex
CREATE INDEX "PlayerStats_biggestWin_idx" ON "PlayerStats"("biggestWin");

-- CreateIndex
CREATE INDEX "DailyStats_date_idx" ON "DailyStats"("date");

-- CreateIndex
CREATE INDEX "DailyStats_userId_date_idx" ON "DailyStats"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyStats_userId_date_key" ON "DailyStats"("userId", "date");

-- AddForeignKey
ALTER TABLE "PlayerStats" ADD CONSTRAINT "PlayerStats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyStats" ADD CONSTRAINT "DailyStats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
